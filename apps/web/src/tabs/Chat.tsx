import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigResponse, SessionEventView, SessionSummary } from '../api'
import { api } from '../api'
import { streamChat } from '../sse'
import type { ApprovalEvent } from '../sse'

interface ToolDisplay {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'ok' | 'fail'
  content?: string
}

interface DisplayMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  usage?: string
  error?: string
  pending?: boolean
  tools?: ToolDisplay[]
}

function safeParseArgs(arguments_: string | undefined): Record<string, unknown> {
  if (!arguments_) return {}
  try {
    return JSON.parse(arguments_) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Rebuild the display list from the log — guarantees multi-step tool ordering. */
function eventsToMessages(events: SessionEventView[]): DisplayMessage[] {
  const out: DisplayMessage[] = []
  for (const event of events) {
    if (event.type === 'user/message' && event.message) {
      out.push({ role: 'user', content: event.message.content })
    } else if (event.type === 'assistant/message' && event.message) {
      out.push({
        role: 'assistant',
        content: event.message.content,
        reasoning: event.message.reasoning || undefined,
        tools: (event.message.toolCalls ?? []).map((call) => ({
          id: call.id,
          name: call.name,
          args: safeParseArgs(call.arguments),
          status: 'running',
        })),
      })
    } else if (event.type === 'tool/result') {
      for (let i = out.length - 1; i >= 0; i--) {
        const tool = out[i]!.tools?.find((entry) => entry.id === event.toolCallId)
        if (tool) {
          tool.status = 'ok'
          tool.content = event.content ?? ''
          break
        }
      }
    } else if (event.type === 'turn/end' && event.error) {
      out.push({ role: 'assistant', content: '', error: event.error })
    }
  }
  return out
}

function formatUsage(usage: { inputTokens: number; outputTokens: number; totalTokens?: number }): string {
  return `tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`
}

function summarize(value: unknown, max = 120): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function Chat({ config, configError }: { config: ConfigResponse | null; configError: string | null }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approval, setApproval] = useState<ApprovalEvent | null>(null)
  const messagesEnd = useRef<HTMLDivElement>(null)

  const endpoints = useMemo(() => Object.entries(config?.config.endpoints ?? {}), [config])
  const endpointConfig = config?.config.endpoints?.[endpoint]

  useEffect(() => {
    if (!config) return
    const fallback = config.config.agent?.endpoint ?? endpoints[0]?.[0] ?? ''
    setEndpoint((prev) => (prev && endpoints.some(([name]) => name === prev) ? prev : fallback))
  }, [config, endpoints])

  useEffect(() => {
    if (!endpointConfig) return
    const fallback = config?.config.agent?.model ?? endpointConfig.models?.[0]?.id ?? ''
    setModel((prev) => prev || fallback)
  }, [endpointConfig, config])

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions())
    } catch {
      // listing failure is non-fatal
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const selectSession = useCallback(async (id: string) => {
    setActiveId(id)
    setError(null)
    try {
      const detail = await api.sessionEvents(id)
      setMessages(eventsToMessages(detail.events))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const newSession = useCallback(() => {
    setActiveId(null)
    setMessages([])
    setError(null)
  }, [])

  const patchTool = useCallback((id: string, patch: Partial<ToolDisplay>) => {
    setMessages((msgs) => {
      const next = [...msgs]
      for (let i = next.length - 1; i >= 0; i--) {
        const tools = next[i]!.tools
        if (!tools) continue
        const at = tools.findIndex((tool) => tool.id === id)
        if (at >= 0) {
          tools[at] = { ...tools[at]!, ...patch }
          break
        }
      }
      return next
    })
  }, [])

  const appendTool = useCallback((tool: ToolDisplay) => {
    setMessages((msgs) => {
      const next = [...msgs]
      const last = next[next.length - 1]
      if (last?.role === 'assistant') next[next.length - 1] = { ...last, tools: [...(last.tools ?? []), tool] }
      return next
    })
  }, [])

  const send = useCallback(async () => {
    const message = input.trim()
    if (!message || streaming) return
    setInput('')
    setError(null)
    setMessages((msgs) => [...msgs, { role: 'user', content: message }, { role: 'assistant', content: '', pending: true }])
    setStreaming(true)
    await streamChat(
      {
        sessionId: activeId ?? undefined,
        message,
        endpoint: endpoint || undefined,
        model: model || undefined,
      },
      {
        onChunk: (chunk) => {
          if (chunk.type === 'text-delta') {
            setMessages((msgs) => {
              const next = [...msgs]
              const last = next[next.length - 1]
              if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + (chunk.delta ?? '') }
              return next
            })
          } else if (chunk.type === 'reasoning-delta') {
            setMessages((msgs) => {
              const next = [...msgs]
              const last = next[next.length - 1]
              if (last?.role === 'assistant') next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? '') + (chunk.delta ?? '') }
              return next
            })
          }
        },
        onTool: (event) => {
          if (event.kind === 'call') {
            appendTool({ id: event.id, name: event.name, args: event.args, status: 'running' })
          } else {
            patchTool(event.id, { status: event.ok ? 'ok' : 'fail', content: event.content })
          }
        },
        onApproval: (event) => setApproval(event),
        onDone: async (done) => {
          if (done.sessionId && done.sessionId !== activeId) setActiveId(done.sessionId)
          // Re-render from the log so multi-step tool sequences stay ordered.
          try {
            const detail = await api.sessionEvents(done.sessionId)
            setMessages(eventsToMessages(detail.events))
          } catch {
            setMessages((msgs) => {
              const next = [...msgs]
              const last = next[next.length - 1]
              if (last?.role === 'assistant') {
                next[next.length - 1] = { ...last, pending: false, usage: done.usage ? formatUsage(done.usage) : undefined }
              }
              return next
            })
          }
          void refreshSessions()
        },
        onError: (msg) => {
          setMessages((msgs) => {
            const next = [...msgs]
            const last = next[next.length - 1]
            if (last?.role === 'assistant') next[next.length - 1] = { ...last, pending: false }
            return next
          })
          setError(msg)
          void refreshSessions()
        },
      },
    )
    setStreaming(false)
  }, [input, streaming, activeId, endpoint, model, appendTool, patchTool, refreshSessions])

  const decideApproval = useCallback(
    async (decision: 'allow' | 'deny' | 'allow-remember') => {
      if (!approval) return
      try {
        await api.resolveApproval(approval.approvalId, decision)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setApproval(null)
      }
    },
    [approval],
  )

  return (
    <div className="chat">
      <aside className="chat-sidebar">
        <div className="sidebar-head">
          <button className="ghost" onClick={newSession} disabled={streaming}>
            ＋ 新建会话
          </button>
        </div>
        <div className="session-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.id === activeId ? 'active' : ''}`}
              onClick={() => void selectSession(session.id)}
            >
              <div className="title">{session.title}</div>
              <div className="time">{new Date(session.updatedAt).toLocaleString()}</div>
            </div>
          ))}
          {sessions.length === 0 && <div className="empty-hint">还没有会话</div>}
        </div>
      </aside>
      <section className="chat-main">
        <div className="messages">
          {messages.map((msg, index) => (
            <div key={index} className={`message ${msg.role}`}>
              <div className="bubble">
                {msg.content}
                {msg.pending && '▍'}
              </div>
              {msg.tools && msg.tools.length > 0 && (
                <div className="tool-list">
                  {msg.tools.map((tool) => (
                    <div key={tool.id} className={`tool-card ${tool.status}`}>
                      <div className="tool-head">
                        {tool.status === 'running' && <span className="tool-spin">◌</span>}
                        {tool.status === 'ok' && <span className="tool-ok">✓</span>}
                        {tool.status === 'fail' && <span className="tool-fail">✗</span>}
                        <span className="tool-name">{tool.name}</span>
                        <span className="tool-args">{summarize(tool.args)}</span>
                      </div>
                      {tool.content !== undefined && (
                        <details className="tool-result">
                          <summary>结果</summary>
                          {tool.content}
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {msg.reasoning && (
                <details className="reasoning" open={msg.content === ''}>
                  <summary>思考过程</summary>
                  {msg.reasoning}
                </details>
              )}
              {msg.usage && <div className="usage-footer">{msg.usage}</div>}
              {msg.error && <div className="error-banner">{msg.error}</div>}
            </div>
          ))}
          {messages.length === 0 && (
            <div className="empty-hint">
              {configError ?? '输入消息开始对话；endpoint/model 在下方选择，历史会话在左侧。'}
            </div>
          )}
          <div ref={messagesEnd} />
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="chat-composer">
          <div className="composer-selectors">
            <label>endpoint</label>
            <select value={endpoint} onChange={(e) => { setEndpoint(e.target.value); setModel('') }} disabled={streaming}>
              {endpoints.map(([name]) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <label>model</label>
            <input
              list="model-options"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model id"
              disabled={streaming}
            />
            <datalist id="model-options">
              {(endpointConfig?.models ?? []).map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </div>
          <div className="composer-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              disabled={streaming}
            />
            <button className="primary" onClick={() => void send()} disabled={streaming || input.trim() === ''}>
              发送
            </button>
          </div>
        </div>
      </section>
      {approval && (
        <div className="modal-mask">
          <div className="modal">
            <h3>工具调用审批</h3>
            <div className="form-row">
              <label>工具</label>
              <div className="approval-tool">{approval.tool}</div>
            </div>
            <div className="form-row">
              <label>参数</label>
              <pre className="yaml-view">{JSON.stringify(approval.args, null, 2)}</pre>
            </div>
            <div className="note">「总是允许」会把 {`{prefix: "${approval.tool}", action: "allow"}`} 写入用户层 guard 策略。</div>
            <div className="modal-actions">
              <button className="ghost danger" onClick={() => void decideApproval('deny')}>
                拒绝
              </button>
              <button className="ghost" onClick={() => void decideApproval('allow-remember')}>
                总是允许
              </button>
              <button className="primary" onClick={() => void decideApproval('allow')}>
                允许
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
