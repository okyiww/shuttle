/** API response shapes (mirrors @shuttle/api responses; fetch-plane only). */
export interface ConfigLayerView {
  path: string
  writable: boolean
}

export interface ModelConfigView {
  id: string
  contextWindow?: number
}

export interface CompatView {
  systemRole?: 'system' | 'developer'
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  thinkingFormat?: 'none' | 'deepseek'
}

export interface EndpointConfigView {
  api: 'openai-completions' | 'anthropic-messages'
  baseURL: string
  /** Masked on every read path (first3****last4, ≤7 chars fully masked). */
  apiKey?: string
  apiKeyEnv: string
  headers?: Record<string, string>
  compat?: CompatView
  models?: ModelConfigView[]
  timeoutMs?: number
  retryPolicy?: { retries?: number; backoffMs?: number }
}

export interface GuardPolicyView {
  prefix: string
  action: 'allow' | 'ask' | 'deny'
}

export interface McpServerBaseView {
  disabled?: boolean
  toolCallTimeoutMs?: number
  auth?: 'none' | 'oauth'
}

export interface McpServerStdioView extends McpServerBaseView {
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface McpServerHttpView extends McpServerBaseView {
  transport: 'streamable-http'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfigView = McpServerStdioView | McpServerHttpView

export interface McpToolView {
  name: string
  description: string
  parameters: unknown
}

export interface McpServerView {
  name: string
  transport: 'stdio' | 'streamable-http'
  status: 'connected' | 'connecting' | 'error' | 'disabled'
  auth: 'authorized' | 'unauthorized' | 'expired' | 'n/a'
  tools: McpToolView[]
  error?: string
}

export interface ShuttleConfigView {
  endpoints?: Record<string, EndpointConfigView>
  agent?: { endpoint?: string; model?: string }
  mcp?: { servers?: Record<string, McpServerConfigView> }
  tools?: { guard?: { policies?: GuardPolicyView[] } }
}

export interface ConfigResponse {
  config: ShuttleConfigView
  layers: ConfigLayerView[]
  yaml: string
}

export interface SessionSummary {
  id: string
  cwd: string
  title: string
  updatedAt: string
}

export interface SessionToolCallView {
  id: string
  name: string
  arguments: string
}

export interface SessionEventView {
  type: string
  at?: string
  turn?: number
  error?: string
  message?: {
    role: string
    content: string
    reasoning?: string
    toolCalls?: SessionToolCallView[]
  }
  toolCallId?: string
  name?: string
  arguments?: string
  content?: string
}

export interface SessionEventsResponse {
  id: string
  cwd: string
  events: SessionEventView[]
}

export interface TestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

export interface DonePayload {
  sessionId: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number }
  finishReason?: string
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown = undefined
  try {
    parsed = JSON.parse(text)
  } catch {
    // non-JSON error body
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `${response.status} ${response.statusText}`
    throw new Error(message)
  }
  return parsed as T
}

export const api = {
  getConfig: () => request<ConfigResponse>('GET', '/api/config'),
  putEndpoint: (name: string, endpoint: EndpointConfigView) =>
    request<ConfigResponse>('PUT', `/api/config/endpoints/${encodeURIComponent(name)}`, endpoint),
  deleteEndpoint: (name: string) => request<ConfigResponse>('DELETE', `/api/config/endpoints/${encodeURIComponent(name)}`),
  setDefault: (endpoint?: string, model?: string) => request<ConfigResponse>('PUT', '/api/config/agent', { endpoint, model }),
  testEndpoint: (name: string) => request<TestResult>('POST', `/api/endpoints/${encodeURIComponent(name)}/test`),
  listSessions: () => request<SessionSummary[]>('GET', '/api/sessions'),
  sessionEvents: (id: string) => request<SessionEventsResponse>('GET', `/api/sessions/${encodeURIComponent(id)}/events`),
  listMcp: () => request<McpServerView[]>('GET', '/api/mcp'),
  putMcpServer: (name: string, server: McpServerConfigView) =>
    request<{ servers: McpServerView[] }>('PUT', `/api/config/mcp/servers/${encodeURIComponent(name)}`, server),
  deleteMcpServer: (name: string) =>
    request<{ servers: McpServerView[] }>('DELETE', `/api/config/mcp/servers/${encodeURIComponent(name)}`),
  reconnectMcp: (name: string) =>
    request<{ servers: McpServerView[] }>('POST', `/api/mcp/servers/${encodeURIComponent(name)}/reconnect`),
  authorizeMcp: (name: string) =>
    request<{ openedBrowser: boolean; authorizationUrl: string }>(
      'POST',
      `/api/mcp/servers/${encodeURIComponent(name)}/authorize`,
    ),
  getGuard: () => request<{ policies: GuardPolicyView[] }>('GET', '/api/config/tools-guard'),
  putGuard: (policies: GuardPolicyView[]) => request<{ policies: GuardPolicyView[] }>('PUT', '/api/config/tools-guard', { policies }),
  resolveApproval: (id: string, decision: 'allow' | 'deny' | 'allow-remember') =>
    request<{ received: boolean }>('POST', `/api/approvals/${encodeURIComponent(id)}`, { decision }),
}
