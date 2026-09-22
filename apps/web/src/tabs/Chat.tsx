import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConfigResponse, SessionEventView, SessionSummary } from '../api'
import { api } from '../api'
import { navigate, useRoute } from '../router'
import { streamChat } from '../sse'
import type { ApprovalEvent } from '../sse'
import { Markdown, firstLine, latestCompletedParagraphFirstLine } from '../markdown'

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
  images?: string[]
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
      out.push({ role: 'user', content: event.message.content, images: event.message.images || undefined })
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
  const route = useRoute()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => route.params.get('session'))
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approval, setApproval] = useState<ApprovalEvent | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [distill, setDistill] = useState<{ markdown: string; path: string; target: 'skill' | 'note'; generating: boolean; sessionIds: string[] } | null>(null)
  const [distilling, setDistilling] = useState(false)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fileInput = useRef<HTMLInputElement>(null)
  const messagesEnd = useRef<HTMLDivElement>(null)

  // composer 只读小字：当前生效的 endpoint/model（选择器已移除，走 agent 默认）
  const endpointsCfg = config?.config.endpoints ?? {}
  const activeEndpointName = config?.config.agent?.endpoint ?? Object.keys(endpointsCfg)[0] ?? ''
  const activeModel =
    (activeEndpointName && (config?.config.agent?.model ?? endpointsCfg[activeEndpointName]?.models?.[0]?.id)) || ''

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
    navigate('chat', { session: id }, { replace: true })
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
    navigate('chat', {}, { replace: true })
  }, [])

  // 刷新/带链接进入时，按 URL 里的 session 恢复会话
  useEffect(() => {
    const id = route.params.get('session')
    if (id) void selectSession(id)
    // 仅挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 浏览器前进/后退等外部 hash 变化 → 同步到当前会话
  useEffect(() => {
    const fromUrl = route.params.get('session')
    if (fromUrl === activeId) return
    if (fromUrl) void selectSession(fromUrl)
    else newSession()
    // activeId 由上面的回调同步维护，无需作为依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route])

  const clearAllSessions = useCallback(async () => {
    if (streaming) return
    if (!confirmingClear) {
      setConfirmingClear(true)
      clearTimer.current = setTimeout(() => setConfirmingClear(false), 3000)
      return
    }
    clearTimeout(clearTimer.current)
    setConfirmingClear(false)
    try {
      await api.clearSessions()
      await refreshSessions()
      newSession()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [confirmingClear, streaming, refreshSessions, newSession])

  const generateDistill = useCallback(async (target: 'skill' | 'note', sessionIds: string[]) => {
    if (sessionIds.length === 0) return
    setDistill((prev) => ({ markdown: '', path: '', target, generating: true, sessionIds: prev?.sessionIds ?? sessionIds }))
    setDistilling(true)
    setError(null)
    try {
      const result = await api.distillSessions(sessionIds, target)
      // 保留用户生成期间调整过的勾选，不重置回本次生成时的快照
      setDistill((prev) => ({
        markdown: result.markdown,
        path: result.suggestedPath,
        target,
        generating: false,
        sessionIds: prev?.sessionIds ?? sessionIds,
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDistill(null)
    } finally {
      setDistilling(false)
    }
  }, [])

  const startDistill = useCallback(() => {
    if (!activeId || streaming) return
    void generateDistill('skill', [activeId])
  }, [activeId, streaming, generateDistill])

  const saveDistill = useCallback(async () => {
    if (!distill) return
    try {
      await api.writeMemory(distill.path, distill.markdown)
      setDistill(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [distill])

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

  const addImages = useCallback((files: File[]) => {
    for (const file of files.slice(0, 4)) {
      if (!file.type.startsWith('image/')) continue
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result)
        setImages((current) => (current.length >= 4 ? current : [...current, dataUrl]))
      }
      reader.readAsDataURL(file)
    }
  }, [])

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
      if (files.length > 0) {
        e.preventDefault()
        addImages(files)
      }
    },
    [addImages],
  )

  const send = useCallback(async () => {
    const message = input.trim()
    if ((!message && images.length === 0) || streaming) return
    const attached = images
    setInput('')
    setImages([])
    setError(null)
    setMessages((msgs) => [...msgs, { role: 'user', content: message, images: attached }, { role: 'assistant', content: '', pending: true }])
    setStreaming(true)
    await streamChat(
      {
        sessionId: activeId ?? undefined,
        message,
        ...(attached.length > 0 ? { images: attached } : {}),
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
          if (done.sessionId && done.sessionId !== activeId) {
            setActiveId(done.sessionId)
            navigate('chat', { session: done.sessionId }, { replace: true })
          }
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
  }, [input, images, streaming, activeId, appendTool, patchTool, refreshSessions])

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
          <button
            className={confirmingClear ? 'danger' : 'ghost'}
            onClick={() => void clearAllSessions()}
            disabled={streaming || sessions.length === 0}
            title={confirmingClear ? '再次点击确认清空，不可恢复' : '清空全部会话'}
          >
            {confirmingClear ? `确认清空 ${sessions.length} 个会话？` : '清空全部会话'}
          </button>
          <button
            className="ghost"
            onClick={() => void startDistill()}
            disabled={!activeId || streaming || distilling}
            title={!activeId ? '先选择一个会话' : '把当前会话沉淀成可复用 skill（草稿可编辑后保存）'}
          >
            {distilling ? '沉淀中…' : '沉淀经验'}
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
              {msg.images && msg.images.length > 0 && (
                <div className="msg-images">
                  {msg.images.map((src, i) => (
                    <img key={i} src={src} alt="附件图片" />
                  ))}
                </div>
              )}
              {(msg.content !== '' || (msg.pending && !msg.reasoning)) && (
                <div className="bubble">
                  {msg.role === 'assistant' ? <Markdown text={msg.content} /> : msg.content}
                  {msg.pending && '▍'}
                </div>
              )}
              {msg.role === 'assistant' && !msg.pending && msg.content === '' && !msg.error &&
                (!msg.tools || msg.tools.length === 0) && (
                  <div className="empty-hint">模型这轮没有返回内容，可以直接重发，或把话说得更具体些</div>
              )}
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
                          <pre className="tool-result-body">{tool.content}</pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {msg.reasoning &&
                (msg.pending ? latestCompletedParagraphFirstLine(msg.reasoning) : firstLine(msg.reasoning)) !== '' && (
                  <details className="reasoning">
                    <summary>
                      <span className="reasoning-label">思考过程</span>
                      <span className="reasoning-preview">
                        {(msg.pending
                          ? latestCompletedParagraphFirstLine(msg.reasoning)
                          : firstLine(msg.reasoning)
                        ).replaceAll('**', '')}
                      </span>
                    </summary>
                    <Markdown text={msg.reasoning} className="reasoning-body" />
                  </details>
                )}
              {msg.usage && <div className="usage-footer">{msg.usage}</div>}
              {msg.error && <div className="error-banner">{msg.error}</div>}
            </div>
          ))}
          {messages.length === 0 && (
            <div className="empty-hint">
              {configError ?? '输入消息开始对话；历史会话在左侧，点「沉淀经验」把对话过程存成可复用的 skill。'}
            </div>
          )}
          <div ref={messagesEnd} />
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="chat-composer">
          <div className="composer-card">
            {images.length > 0 && (
              <div className="composer-images">
                {images.map((src, i) => (
                  <div key={i} className="composer-image">
                    <img src={src} alt="待发送图片" />
                    <button
                      className="composer-image-remove"
                      onClick={() => setImages((current) => current.filter((_, at) => at !== i))}
                      title="移除"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (e.nativeEvent.isComposing) return
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="输入消息，Enter 换行，Cmd/Ctrl+Enter 发送；可直接粘贴图片"
              disabled={streaming}
              rows={3}
            />
            <div className="composer-footer">
              <button
                className="ghost composer-attach"
                onClick={() => fileInput.current?.click()}
                disabled={streaming}
                title="添加图片（也可直接粘贴）"
              >
                ＋ 图片
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  addImages([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
              <span className="composer-target">
                {activeEndpointName}
                {activeModel ? ` · ${activeModel}` : ''}
              </span>
              <button
                className="primary"
                onClick={() => void send()}
                disabled={streaming || (input.trim() === '' && images.length === 0)}
              >
                发送
              </button>
            </div>
          </div>
        </div>
      </section>
      {distill && (
        <div className="modal-mask">
          <div className="modal modal-wide">
            <h3>沉淀经验</h3>
            <div className="form-row">
              <label>沉淀范围（可勾选多个会话合并提炼）</label>
              <div className="distill-sessions">
                {sessions.map((session) => (
                  <label key={session.id} className="distill-session">
                    <input
                      type="checkbox"
                      checked={distill.sessionIds.includes(session.id)}
                      onChange={(e) =>
                        setDistill({
                          ...distill,
                          sessionIds: e.target.checked
                            ? [...distill.sessionIds, session.id]
                            : distill.sessionIds.filter((id) => id !== session.id),
                        })
                      }
                    />
                    <span className="distill-session-title">{session.title}</span>
                    <span className="dim">{new Date(session.updatedAt).toLocaleDateString()}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="form-row">
              <label>沉淀类型</label>
              <div className="distill-target">
                <button
                  className={distill.target === 'skill' ? 'primary' : 'ghost'}
                  disabled={distill.generating || distill.sessionIds.length === 0}
                  onClick={() => void generateDistill('skill', distill.sessionIds)}
                >
                  技能（模型自动加载的手册）
                </button>
                <button
                  className={distill.target === 'note' ? 'primary' : 'ghost'}
                  disabled={distill.generating || distill.sessionIds.length === 0}
                  onClick={() => void generateDistill('note', distill.sessionIds)}
                >
                  笔记（决策/经验记录）
                </button>
              </div>
            </div>
            {distill.generating && <div className="note">正在生成草稿…</div>}
            <div className="form-row">
              <label>保存路径（必须在 .shuttle 内，.md 结尾）</label>
              <input value={distill.path} onChange={(e) => setDistill({ ...distill, path: e.target.value })} />
            </div>
            <div className="form-row">
              <label>markdown 草稿（可编辑）</label>
              <textarea
                className="markdown-edit"
                value={distill.markdown}
                onChange={(e) => setDistill({ ...distill, markdown: e.target.value })}
              />
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setDistill(null)}>
                取消
              </button>
              <button
                className="primary"
                onClick={() => void saveDistill()}
                disabled={distill.generating || distill.path.trim() === '' || distill.markdown.trim() === ''}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
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
