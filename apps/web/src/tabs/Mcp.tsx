import { useCallback, useEffect, useState } from 'react'
import type { GuardPolicyView, McpServerConfigView, McpServerView } from '../api'
import { api } from '../api'

interface Draft {
  name: string
  transport: 'stdio' | 'streamable-http'
  auth: 'none' | 'oauth'
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
  toolCallTimeoutMs: string
}

const emptyDraft: Draft = {
  name: '',
  transport: 'stdio',
  auth: 'none',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
  toolCallTimeoutMs: '',
}

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseKeyValue(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of parseLines(text)) {
    const at = line.indexOf('=')
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

function draftToBody(draft: Draft): McpServerConfigView {
  const base: { disabled?: boolean; toolCallTimeoutMs?: number; auth?: 'none' | 'oauth' } = {}
  if (draft.toolCallTimeoutMs.trim() !== '') {
    const value = Number(draft.toolCallTimeoutMs)
    if (Number.isInteger(value) && value > 0) base.toolCallTimeoutMs = value
  }
  if (draft.transport === 'stdio') {
    return {
      ...base,
      transport: 'stdio',
      command: draft.command.trim(),
      ...(parseLines(draft.argsText).length > 0 ? { args: parseLines(draft.argsText) } : {}),
      ...(Object.keys(parseKeyValue(draft.envText)).length > 0 ? { env: parseKeyValue(draft.envText) } : {}),
    }
  }
  return {
    ...base,
    transport: 'streamable-http',
    auth: draft.auth,
    url: draft.url.trim(),
    ...(Object.keys(parseKeyValue(draft.headersText)).length > 0 ? { headers: parseKeyValue(draft.headersText) } : {}),
  }
}

function draftFrom(name: string, server: McpServerConfigView | undefined): Draft {
  if (!server) return { ...emptyDraft, name }
  if (server.transport === 'stdio') {
    return {
      name,
      transport: 'stdio',
      auth: 'none',
      command: server.command,
      argsText: (server.args ?? []).join('\n'),
      envText: Object.entries(server.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      url: '',
      headersText: '',
      toolCallTimeoutMs: server.toolCallTimeoutMs ? String(server.toolCallTimeoutMs) : '',
    }
  }
  return {
    name,
    transport: 'streamable-http',
    auth: server.auth ?? 'none',
    command: '',
    argsText: '',
    envText: '',
    url: server.url,
    headersText: Object.entries(server.headers ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    toolCallTimeoutMs: server.toolCallTimeoutMs ? String(server.toolCallTimeoutMs) : '',
  }
}

const STATUS_LABEL: Record<McpServerView['status'], string> = {
  connected: '已连接',
  connecting: '连接中',
  error: '错误',
  disabled: '已停用',
}

const AUTH_LABEL: Record<McpServerView['auth'], string> = {
  authorized: '已授权',
  unauthorized: '未授权',
  expired: '令牌过期',
  'n/a': '',
}

export function Mcp({ onConfigChanged }: { onConfigChanged: () => Promise<void> }) {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [configDefs, setConfigDefs] = useState<Record<string, McpServerConfigView>>({})
  const [editing, setEditing] = useState<Draft | null>(null)
  const [policies, setPolicies] = useState<GuardPolicyView[]>([])
  const [pageError, setPageError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [manualUrl, setManualUrl] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, config] = await Promise.all([api.listMcp(), api.getConfig()])
      setServers(list)
      setConfigDefs(config.config.mcp?.servers ?? {})
      setPolicies(config.config.tools?.guard?.policies ?? [])
      setPageError(null)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh])

  const submit = async () => {
    if (!editing) return
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(editing.name)) {
      setPageError('name 只允许 [A-Za-z0-9_-]，最长 32 字符')
      return
    }
    try {
      await api.putMcpServer(editing.name, draftToBody(editing))
      await onConfigChanged()
      await refresh()
      setEditing(null)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggle = async (server: McpServerView) => {
    const def = configDefs[server.name]
    if (!def) {
      setPageError(`配置里找不到 ${server.name}（可能只定义在项目层，请先在弹窗里保存到用户层）`)
      return
    }
    try {
      await api.putMcpServer(server.name, { ...def, disabled: !def.disabled })
      await onConfigChanged()
      await refresh()
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error))
    }
  }

  const reconnect = async (name: string) => {
    try {
      await api.reconnectMcp(name)
      await refresh()
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error))
    }
  }

  /** OAuth: open the browser, or hand the URL to the user when that fails. */
  const authorize = async (name: string) => {
    try {
      const result = await api.authorizeMcp(name)
      setNotice(result.openedBrowser ? '已在浏览器打开授权页，完成授权后此处自动更新。' : null)
      if (!result.openedBrowser) setManualUrl(result.authorizationUrl)
      await refresh()
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error))
    }
  }

  const remove = async (name: string) => {
    if (!window.confirm(`确定删除 MCP server「${name}」？（只影响用户层）`)) return
    try {
      await api.deleteMcpServer(name)
      await onConfigChanged()
      await refresh()
    } catch (error) {
      setPageError(error instanceof Error ? errMessage(error) : String(error))
    }
  }

  const savePolicies = async () => {
    const cleaned = policies.filter((policy) => policy.prefix.trim() !== '')
    try {
      await api.putGuard(cleaned)
      await onConfigChanged()
      await refresh()
      setNotice('guard 策略已保存到用户层')
      setTimeout(() => setNotice(null), 3000)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>MCP</h2>
          <div className="subtitle">外部能力一律走 MCP：server 启停 = 执行/回卷它的 effect，工具注册为 mcp__&lt;server&gt;__&lt;tool&gt;。</div>
        </div>
        <button className="primary" onClick={() => setEditing({ ...emptyDraft })}>
          ＋ 添加服务器
        </button>
      </div>
      {pageError && <div className="error-banner">{pageError}</div>}
      {notice && <div className="note">{notice}</div>}
      <div className="endpoint-grid">
        {servers.map((server) => {
          const isOauth = configDefs[server.name]?.auth === 'oauth'
          return (
            <div className="endpoint-card" key={server.name}>
              <div className="card-head">
                <span className={`status-dot ${server.status}`} title={STATUS_LABEL[server.status]} />
                <span className="name">{server.name}</span>
                <span className="badge api">{server.transport}</span>
                {isOauth && server.auth !== 'n/a' && (
                  <span className={`badge auth-${server.auth}`}>{AUTH_LABEL[server.auth]}</span>
                )}
                {configDefs[server.name]?.disabled && <span className="badge">停用中</span>}
              </div>
              <div className="meta">
                {STATUS_LABEL[server.status]}
                {server.tools.length > 0 && ` · ${server.tools.length} 个工具`}
              </div>
              {server.error && <div className="test-result fail">{server.error}</div>}
              {server.tools.length > 0 && (
                <details>
                  <summary className="tool-summary">工具列表</summary>
                  <div className="mcp-tools">
                    {server.tools.map((tool) => (
                      <details key={tool.name} className="mcp-tool">
                        <summary>
                          <code>{tool.name}</code> <span className="dim">{tool.description}</span>
                        </summary>
                        <pre className="yaml-view">{JSON.stringify(tool.parameters, null, 2)}</pre>
                      </details>
                    ))}
                  </div>
                </details>
              )}
              <div className="card-actions">
                {isOauth && (
                  <button className="ghost" onClick={() => void authorize(server.name)}>
                    {server.auth === 'authorized' ? '重新授权' : '授权登录'}
                  </button>
                )}
                <button className="ghost" onClick={() => void toggle(server)} disabled={!configDefs[server.name]}>
                  {configDefs[server.name]?.disabled ? '启用' : '停用'}
                </button>
                <button className="ghost" onClick={() => void reconnect(server.name)} disabled={configDefs[server.name]?.disabled === true}>
                  重连
                </button>
                <button className="ghost" onClick={() => setEditing(draftFrom(server.name, configDefs[server.name]))}>
                  编辑
                </button>
                <button className="ghost danger" onClick={() => void remove(server.name)}>
                  删除
                </button>
              </div>
            </div>
          )
        })}
        {servers.length === 0 && <div className="empty-hint">还没有 MCP server —— 点右上角添加（stdio 或 streamable-http）。</div>}
      </div>

      {manualUrl && (
        <div className="modal-mask" onClick={() => setManualUrl(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>完成授权</h3>
            <div className="note">无法自动打开浏览器，请手动打开下面的授权链接（登录后自动跳回 Shuttle）：</div>
            <pre className="yaml-view">{manualUrl}</pre>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setManualUrl(null)}>
                关闭
              </button>
              <button className="primary" onClick={() => window.open(manualUrl, '_blank')}>
                打开授权页
              </button>
            </div>
          </div>
        </div>
      )}

      <h2 style={{ fontSize: 15, marginTop: 28 }}>Guard 策略</h2>
      <div className="note">
        按工具名前缀最长匹配：<code>mcp__jira__</code> 管整个 jira server，精确全名管单个工具；写操作默认 ask，读操作 allow。
      </div>
      <div className="guard-table">
        {policies.map((policy, index) => (
          <div className="guard-row" key={index}>
            <input
              value={policy.prefix}
              placeholder="mcp__jira__ 或工具全名"
              onChange={(e) =>
                setPolicies((prev) => prev.map((entry, i) => (i === index ? { ...entry, prefix: e.target.value } : entry)))
              }
            />
            <select
              value={policy.action}
              onChange={(e) =>
                setPolicies((prev) =>
                  prev.map((entry, i) => (i === index ? { ...entry, action: e.target.value as GuardPolicyView['action'] } : entry)),
                )
              }
            >
              <option value="allow">allow</option>
              <option value="ask">ask</option>
              <option value="deny">deny</option>
            </select>
            <button
              className="ghost danger"
              onClick={() => setPolicies((prev) => prev.filter((_, i) => i !== index))}
            >
              删
            </button>
          </div>
        ))}
        <div className="guard-actions">
          <button className="ghost" onClick={() => setPolicies((prev) => [...prev, { prefix: 'mcp__', action: 'ask' }])}>
            ＋ 添加策略
          </button>
          <button className="primary" onClick={() => void savePolicies()}>
            保存到用户层
          </button>
        </div>
      </div>

      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{configDefs[editing.name] ? `编辑 ${editing.name}` : '添加服务器'}</h3>
            <div className="form-row">
              <label>name（本地命名空间，保存后不可改）</label>
              <input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                disabled={Boolean(configDefs[editing.name])}
                placeholder="jira"
              />
            </div>
            <div className="form-row">
              <label>transport</label>
              <select
                value={editing.transport}
                onChange={(e) => setEditing({ ...editing, transport: e.target.value as Draft['transport'] })}
              >
                <option value="stdio">stdio（子进程）</option>
                <option value="streamable-http">streamable-http</option>
              </select>
            </div>
            {editing.transport === 'streamable-http' && (
              <div className="form-row">
                <label>auth（OAuth 2.0：动态注册 + 浏览器登录 + 自动刷新）</label>
                <select
                  value={editing.auth}
                  onChange={(e) => setEditing({ ...editing, auth: e.target.value as Draft['auth'] })}
                >
                  <option value="none">none（静态 headers）</option>
                  <option value="oauth">oauth（Authorization Code + PKCE）</option>
                </select>
              </div>
            )}
            {editing.transport === 'stdio' ? (
              <>
                <div className="form-row">
                  <label>command</label>
                  <input
                    value={editing.command}
                    onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                    placeholder="node"
                  />
                </div>
                <div className="form-row">
                  <label>args（每行一条）</label>
                  <textarea
                    rows={3}
                    value={editing.argsText}
                    onChange={(e) => setEditing({ ...editing, argsText: e.target.value })}
                    placeholder={'/path/to/server/dist/index.js'}
                  />
                </div>
                <div className="form-row">
                  <label>env（KEY=VALUE 每行一条；子进程从脱敏父环境起步）</label>
                  <textarea
                    rows={3}
                    value={editing.envText}
                    onChange={(e) => setEditing({ ...editing, envText: e.target.value })}
                    placeholder={'JIRA_TOKEN=xxx'}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="form-row">
                  <label>url</label>
                  <input
                    value={editing.url}
                    onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                    placeholder="http://127.0.0.1:7700/mcp"
                  />
                </div>
                <div className="form-row">
                  <label>headers（KEY=VALUE 每行一条）</label>
                  <textarea
                    rows={3}
                    value={editing.headersText}
                    onChange={(e) => setEditing({ ...editing, headersText: e.target.value })}
                    placeholder={'Authorization=Bearer xxx'}
                  />
                </div>
              </>
            )}
            <div className="form-row">
              <label>toolCallTimeoutMs（可选）</label>
              <input
                value={editing.toolCallTimeoutMs}
                onChange={(e) => setEditing({ ...editing, toolCallTimeoutMs: e.target.value })}
                placeholder="30000"
              />
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="primary" onClick={() => void submit()}>
                保存到用户层
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
