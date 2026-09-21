export type LlmApi = 'openai-completions' | 'anthropic-messages'

export interface ModelConfig {
  id: string
  contextWindow?: number
}

export interface RetryPolicyConfig {
  retries?: number
  backoffMs?: number
}

export interface CompatConfig {
  systemRole?: 'system' | 'developer'
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  thinkingFormat?: 'none' | 'deepseek'
}

export interface EndpointConfig {
  api: LlmApi
  baseURL: string
  /**
   * Real API key. Resolution order: `apiKey` (this field) → env var named by
   * `apiKeyEnv` → MISSING_CREDENTIAL. Only ever persisted to the user layer
   * (0600); every read path returns it masked via `maskConfig`.
   */
  apiKey?: string
  apiKeyEnv: string
  headers?: Record<string, string>
  compat?: CompatConfig
  models?: ModelConfig[]
  timeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

export interface AgentConfig {
  endpoint?: string
  model?: string
}

export interface McpServerBaseConfig {
  /** Stop the server without forgetting it (web toggle; stays in config). */
  disabled?: boolean
  /** Per-call timeout for tool invocations, milliseconds. */
  toolCallTimeoutMs?: number
  /** 'none' (default): static headers only. 'oauth': OAuth 2.0 with DCR + PKCE + refresh. */
  auth?: 'none' | 'oauth'
}

export interface McpServerStdioConfig extends McpServerBaseConfig {
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface McpServerHttpConfig extends McpServerBaseConfig {
  transport: 'streamable-http'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = McpServerStdioConfig | McpServerHttpConfig

/** serverName -> transport config; serverName is the local namespace (mcp__<serverName>__<toolName>). */
export type McpServersConfig = Record<string, McpServerConfig>

export type GuardAction = 'allow' | 'ask' | 'deny'

export interface GuardPolicy {
  /** Longest prefix match on the tool name wins (e.g. `mcp__jira__`). */
  prefix: string
  action: GuardAction
}

export interface ToolsConfig {
  guard?: { policies?: GuardPolicy[] }
}

export interface ShuttleConfig {
  endpoints?: Record<string, EndpointConfig>
  mcp?: { servers?: McpServersConfig }
  agent?: AgentConfig
  tools?: ToolsConfig
}

export interface ConfigLayer {
  path: string
  config: ShuttleConfig
  writable: boolean
}

export interface LoadedConfig {
  config: ShuttleConfig
  layers: ConfigLayer[]
}
