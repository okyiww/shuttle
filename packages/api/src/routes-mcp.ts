import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import type { GuardPolicy, McpServerConfig } from '@shuttle/config'
import { ConfigError, validateConfig, writeUserLayer } from '@shuttle/config'
import type { AskDecision } from '@shuttle/tools'
import { resolveApproval } from './approvals.js'
import { rememberToolAllowed } from './chat.js'
import { HttpError, readJsonBody, sendError, sendJson } from './http-utils.js'
import type { ApiState } from './state.js'

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function handleListMcp(_req: IncomingMessage, res: ServerResponse, state: ApiState): void {
  sendJson(res, 200, state.mcp.listServers())
}

/** PUT /api/config/mcp/servers/:name — add or replace an MCP server (user layer, hot-applied). */
export async function handlePutMcpServer(req: IncomingMessage, res: ServerResponse, state: ApiState, name: string): Promise<void> {
  if (!NAME_PATTERN.test(name)) throw new HttpError(400, `invalid server name: ${name} (expected [A-Za-z0-9_-]{1,32})`)
  const raw = await readJsonBody(req)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'body must be a server config object')
  let server: McpServerConfig
  try {
    const parsed = validateConfig({ mcp: { servers: { [name]: raw } } }, 'request body', new Map())
    server = parsed.mcp!.servers![name]!
  } catch (error) {
    if (error instanceof ConfigError) throw new HttpError(400, error.message)
    throw error
  }
  try {
    writeUserLayer({ mcp: { servers: { [name]: server } } }, { replace: [`mcp.servers.${name}`] })
  } catch (error) {
    if (error instanceof ConfigError) throw new HttpError(400, error.message)
    throw error
  }
  state.reloadConfig()
  sendJson(res, 200, { servers: state.mcp.listServers() })
}

/** DELETE /api/config/mcp/servers/:name — remove from the user layer. */
export function handleDeleteMcpServer(_req: IncomingMessage, res: ServerResponse, state: ApiState, name: string): void {
  writeUserLayer({}, { remove: [`mcp.servers.${name}`] })
  state.reloadConfig()
  sendJson(res, 200, { servers: state.mcp.listServers() })
}

/** POST /api/mcp/servers/:name/reconnect — tear down and reconnect now. */
export function handleReconnectMcp(_req: IncomingMessage, res: ServerResponse, state: ApiState, name: string): void {
  try {
    state.mcp.reconnect(name)
  } catch (error) {
    sendError(res, 404, error instanceof Error ? error.message : String(error))
    return
  }
  sendJson(res, 200, { servers: state.mcp.listServers() })
}

/** GET /api/config/tools-guard — merged policies. */
export function handleGetGuard(_req: IncomingMessage, res: ServerResponse, state: ApiState): void {
  sendJson(res, 200, { policies: state.loaded.config.tools?.guard?.policies ?? [] })
}

/** PUT /api/config/tools-guard — wholesale replace policies (user layer). */
export async function handlePutGuard(req: IncomingMessage, res: ServerResponse, state: ApiState): Promise<void> {
  const raw = (await readJsonBody(req)) as { policies?: unknown }
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'body must be an object')
  let policies: GuardPolicy[]
  try {
    const parsed = validateConfig({ tools: { guard: { policies: raw.policies ?? [] } } }, 'request body', new Map())
    policies = parsed.tools?.guard?.policies ?? []
  } catch (error) {
    if (error instanceof ConfigError) throw new HttpError(400, error.message)
    throw error
  }
  writeUserLayer({ tools: { guard: { policies } } })
  state.reloadConfig()
  sendJson(res, 200, { policies: state.loaded.config.tools?.guard?.policies ?? [] })
}

/** POST /api/approvals/:id — allow / deny / allow-remember a guarded tool call. */
export async function handleResolveApproval(req: IncomingMessage, res: ServerResponse, state: ApiState, id: string): Promise<void> {
  const raw = (await readJsonBody(req)) as { decision?: unknown }
  const decision = raw?.decision
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'allow-remember') {
    sendError(res, 400, "decision must be 'allow' | 'deny' | 'allow-remember'")
    return
  }
  const ok = resolveApproval(id, decision as AskDecision, { onRemember: (tool) => rememberToolAllowed(state, tool) })
  if (!ok) {
    sendError(res, 404, `approval not found or expired: ${id}`)
    return
  }
  sendJson(res, 200, { received: true })
}

/** Open the authorization URL in the system browser; false when unsupported/failing. */
function tryOpenBrowser(url: string): boolean {
  if (process.env.SHUTTLE_NO_OPEN) return false
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined
  if (!command) return false
  try {
    const child = spawn(command, [url], { stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}

/** POST /api/mcp/servers/:name/authorize — OAuth discovery → DCR → PKCE URL. */
export async function handleAuthorizeMcp(req: IncomingMessage, res: ServerResponse, state: ApiState, name: string): Promise<void> {
  void req
  let authorizationUrl: string
  try {
    ;({ authorizationUrl } = await state.mcp.authorize(name))
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error))
    return
  }
  const openedBrowser = tryOpenBrowser(authorizationUrl)
  sendJson(res, 200, { openedBrowser, authorizationUrl })
}

/** GET /api/oauth/callback — loopback OAuth landing page (browser-facing HTML). */
export async function handleOAuthCallback(req: IncomingMessage, res: ServerResponse, state: ApiState, query: URLSearchParams): Promise<void> {
  const code = query.get('code') ?? undefined
  const oauthError = query.get('error') ?? undefined
  const stateParam = query.get('state') ?? ''
  const page = (title: string, detail: string, ok: boolean): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>` +
        `<style>body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}` +
        `.card{max-width:520px;padding:32px;text-align:center}h1{color:${ok ? '#3fb950' : '#f85149'}code{color:#8b949e}</style></head>` +
        `<body><div class="card"><h1>${title}</h1><p>${detail}</p><p><code>可以关闭此页，回 Shuttle 查看连接状态。</code></p></div></body></html>`,
    )
  }
  try {
    const serverName = await state.mcp.completeAuthorization(stateParam, code, oauthError)
    page('授权成功', `MCP server <b>${serverName}</b> 已拿到访问令牌，正在连接。`, true)
  } catch (error) {
    page('授权失败', error instanceof Error ? error.message : String(error), false)
  }
}
