import { ConfigError } from './errors.js'
import type {
  AgentConfig,
  CompatConfig,
  EndpointConfig,
  GuardPolicy,
  McpServerConfig,
  ModelConfig,
  RetryPolicyConfig,
  ShuttleConfig,
  ToolsConfig,
} from './types.js'

type YamlMap = Record<string, unknown>

const API_VALUES = ['openai-completions', 'anthropic-messages', 'ollama'] as const
const SYSTEM_ROLE_VALUES = ['system', 'developer'] as const
const MAX_TOKENS_FIELD_VALUES = ['max_tokens', 'max_completion_tokens'] as const
const THINKING_FORMAT_VALUES = ['none', 'deepseek'] as const
const TRANSPORT_VALUES = ['stdio', 'streamable-http'] as const

const KNOWN_TOP_KEYS = ['endpoints', 'mcp', 'agent', 'tools'] as const
const KNOWN_ENDPOINT_KEYS = ['api', 'baseURL', 'apiKey', 'apiKeyEnv', 'headers', 'compat', 'models', 'timeoutMs', 'retryPolicy'] as const
const KNOWN_COMPAT_KEYS = ['systemRole', 'maxTokensField', 'thinkingFormat'] as const
const KNOWN_MODEL_KEYS = ['id', 'contextWindow'] as const
const KNOWN_RETRY_KEYS = ['retries', 'backoffMs'] as const
const KNOWN_AGENT_KEYS = ['endpoint', 'model'] as const
const KNOWN_MCP_KEYS = ['servers'] as const
const KNOWN_STDIO_KEYS = ['transport', 'command', 'args', 'env', 'cwd', 'disabled', 'toolCallTimeoutMs', 'auth'] as const
const KNOWN_HTTP_KEYS = ['transport', 'url', 'headers', 'disabled', 'toolCallTimeoutMs', 'auth'] as const
const KNOWN_TOOLS_KEYS = ['guard'] as const
const KNOWN_GUARD_KEYS = ['policies'] as const
const GUARD_ACTION_VALUES = ['allow', 'ask', 'deny'] as const
const AUTH_VALUES = ['none', 'oauth'] as const

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'

/** Structural validation with source positions; fills defaults (e.g. `api`). */
export function validateConfig(value: YamlMap, source: string, lines: Map<string, number>): ShuttleConfig {
  rejectUnknownKeys(value, KNOWN_TOP_KEYS, '', source, lines)
  const config: ShuttleConfig = {}
  if ('endpoints' in value) {
    const endpoints = expectMap(value.endpoints, 'endpoints', source, lines)
    rejectUnknownKeys(endpoints, [], 'endpoints', source, lines)
    const parsed: Record<string, EndpointConfig> = {}
    for (const [name, raw] of Object.entries(endpoints)) {
      parsed[name] = validateEndpoint(name, expectMap(raw, `endpoints.${name}`, source, lines), source, lines)
    }
    config.endpoints = parsed
  }
  if ('mcp' in value) {
    const mcp = expectMap(value.mcp, 'mcp', source, lines)
    rejectUnknownKeys(mcp, KNOWN_MCP_KEYS, 'mcp', source, lines)
    const serversRaw = 'servers' in mcp ? expectMap(mcp.servers, 'mcp.servers', source, lines) : {}
    rejectUnknownKeys(serversRaw, [], 'mcp.servers', source, lines)
    const servers: ShuttleConfig['mcp'] = { servers: {} }
    for (const [name, raw] of Object.entries(serversRaw)) {
      servers.servers![name] = validateMcpServer(name, expectMap(raw, `mcp.servers.${name}`, source, lines), source, lines)
    }
    config.mcp = servers
  }
  if ('agent' in value) {
    const agent = expectMap(value.agent, 'agent', source, lines)
    rejectUnknownKeys(agent, KNOWN_AGENT_KEYS, 'agent', source, lines)
    const parsed: AgentConfig = {}
    if ('endpoint' in agent) parsed.endpoint = expectString(agent.endpoint, 'agent.endpoint', source, lines)
    if ('model' in agent) parsed.model = expectString(agent.model, 'agent.model', source, lines)
    config.agent = parsed
  }
  if ('tools' in value) {
    const tools = expectMap(value.tools, 'tools', source, lines)
    rejectUnknownKeys(tools, KNOWN_TOOLS_KEYS, 'tools', source, lines)
    const parsed: ToolsConfig = {}
    if ('guard' in tools) {
      const guard = expectMap(tools.guard, 'tools.guard', source, lines)
      rejectUnknownKeys(guard, KNOWN_GUARD_KEYS, 'tools.guard', source, lines)
      if ('policies' in guard) {
        const policies = expectArray(guard.policies, 'tools.guard.policies', source, lines)
        parsed.guard = {
          policies: policies.map((entry, i) => {
            const policy = expectMap(entry, `tools.guard.policies.${i}`, source, lines)
            rejectUnknownKeys(policy, ['prefix', 'action'], `tools.guard.policies.${i}`, source, lines)
            return {
              prefix: expectString(policy.prefix, `tools.guard.policies.${i}.prefix`, source, lines),
              action: expectEnum(policy.action, GUARD_ACTION_VALUES, `tools.guard.policies.${i}.action`, source, lines),
            }
          }),
        }
      } else {
        parsed.guard = {}
      }
    }
    config.tools = parsed
  }
  return config
}

function validateEndpoint(name: string, raw: YamlMap, source: string, lines: Map<string, number>): EndpointConfig {
  const path = `endpoints.${name}`
  rejectUnknownKeys(raw, KNOWN_ENDPOINT_KEYS, path, source, lines)
  const api = 'api' in raw ? expectEnum(raw.api, API_VALUES, `${path}.api`, source, lines) : 'openai-completions'
  const endpoint: EndpointConfig = { api, baseURL: '' }
  // ollama is a local, keyless service: a missing/empty baseURL falls back to
  // its localhost default; every other api keeps baseURL required.
  if (api === 'ollama' && (raw.baseURL === undefined || raw.baseURL === '')) {
    endpoint.baseURL = DEFAULT_OLLAMA_BASE_URL
  } else {
    endpoint.baseURL = expectString(raw.baseURL, `${path}.baseURL`, source, lines)
  }
  if ('apiKey' in raw) {
    // Real keys live only in the user layer (0600). Empty string means
    // "cleared" — resolution falls through to apiKeyEnv at request time.
    if (typeof raw.apiKey !== 'string') {
      throw new ConfigError('CONFIG_INVALID', `${path}.apiKey must be a string`, { path: source, line: lines.get(`${path}.apiKey`) })
    }
    endpoint.apiKey = raw.apiKey
  }
  if ('apiKeyEnv' in raw) endpoint.apiKeyEnv = expectString(raw.apiKeyEnv, `${path}.apiKeyEnv`, source, lines)
  if ('headers' in raw) endpoint.headers = expectStringMap(raw.headers, `${path}.headers`, source, lines)
  if ('compat' in raw) {
    const compat = expectMap(raw.compat, `${path}.compat`, source, lines)
    rejectUnknownKeys(compat, KNOWN_COMPAT_KEYS, `${path}.compat`, source, lines)
    const parsed: CompatConfig = {}
    if ('systemRole' in compat) parsed.systemRole = expectEnum(compat.systemRole, SYSTEM_ROLE_VALUES, `${path}.compat.systemRole`, source, lines)
    if ('maxTokensField' in compat) parsed.maxTokensField = expectEnum(compat.maxTokensField, MAX_TOKENS_FIELD_VALUES, `${path}.compat.maxTokensField`, source, lines)
    if ('thinkingFormat' in compat) parsed.thinkingFormat = expectEnum(compat.thinkingFormat, THINKING_FORMAT_VALUES, `${path}.compat.thinkingFormat`, source, lines)
    endpoint.compat = parsed
  }
  if ('models' in raw) {
    const models = expectArray(raw.models, `${path}.models`, source, lines)
    endpoint.models = models.map((entry, i) => {
      const model = expectMap(entry, `${path}.models.${i}`, source, lines)
      rejectUnknownKeys(model, KNOWN_MODEL_KEYS, `${path}.models.${i}`, source, lines)
      const parsed: ModelConfig = { id: expectString(model.id, `${path}.models.${i}.id`, source, lines) }
      if ('contextWindow' in model) parsed.contextWindow = expectPositiveInt(model.contextWindow, `${path}.models.${i}.contextWindow`, source, lines)
      return parsed
    })
  }
  if ('timeoutMs' in raw) endpoint.timeoutMs = expectPositiveInt(raw.timeoutMs, `${path}.timeoutMs`, source, lines)
  if ('retryPolicy' in raw) {
    const retry = expectMap(raw.retryPolicy, `${path}.retryPolicy`, source, lines)
    rejectUnknownKeys(retry, KNOWN_RETRY_KEYS, `${path}.retryPolicy`, source, lines)
    const parsed: RetryPolicyConfig = {}
    if ('retries' in retry) parsed.retries = expectNonNegativeInt(retry.retries, `${path}.retryPolicy.retries`, source, lines)
    if ('backoffMs' in retry) parsed.backoffMs = expectNonNegativeInt(retry.backoffMs, `${path}.retryPolicy.backoffMs`, source, lines)
    endpoint.retryPolicy = parsed
  }
  return endpoint
}

function validateMcpServer(name: string, raw: YamlMap, source: string, lines: Map<string, number>): McpServerConfig {
  const path = `mcp.servers.${name}`
  const base: McpServerConfig = {} as McpServerConfig
  if ('disabled' in raw) {
    if (typeof raw.disabled !== 'boolean') {
      throw new ConfigError('CONFIG_INVALID', `${path}.disabled must be a boolean`, { path: source, line: lines.get(`${path}.disabled`) })
    }
    base.disabled = raw.disabled
  }
  if ('toolCallTimeoutMs' in raw) {
    base.toolCallTimeoutMs = expectPositiveInt(raw.toolCallTimeoutMs, `${path}.toolCallTimeoutMs`, source, lines)
  }
  if ('auth' in raw) {
    base.auth = expectEnum(raw.auth, AUTH_VALUES, `${path}.auth`, source, lines)
  }
  const transport = expectEnum(raw.transport, TRANSPORT_VALUES, `${path}.transport`, source, lines)
  if (transport === 'stdio') {
    rejectUnknownKeys(raw, KNOWN_STDIO_KEYS, path, source, lines)
    const server: McpServerConfig = {
      ...base,
      transport,
      command: expectString(raw.command, `${path}.command`, source, lines),
    }
    if ('args' in raw) {
      const args = expectArray(raw.args, `${path}.args`, source, lines)
      server.args = args.map((arg, i) => expectString(arg, `${path}.args.${i}`, source, lines))
    }
    if ('env' in raw) server.env = expectStringMap(raw.env, `${path}.env`, source, lines)
    if ('cwd' in raw) server.cwd = expectString(raw.cwd, `${path}.cwd`, source, lines)
    return server
  }
  rejectUnknownKeys(raw, KNOWN_HTTP_KEYS, path, source, lines)
  const server: McpServerConfig = {
    ...base,
    transport,
    url: expectString(raw.url, `${path}.url`, source, lines),
  }
  if ('headers' in raw) server.headers = expectStringMap(raw.headers, `${path}.headers`, source, lines)
  return server
}

function rejectUnknownKeys(map: YamlMap, known: readonly string[], path: string, source: string, lines: Map<string, number>): void {
  for (const key of Object.keys(map)) {
    const full = path ? `${path}.${key}` : key
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new ConfigError('CONFIG_INVALID', `unsafe key: ${full}`, { path: source, line: lines.get(full) })
    }
    if (known.length > 0 && !known.includes(key)) {
      throw new ConfigError('CONFIG_INVALID', `unknown key: ${full}`, { path: source, line: lines.get(full) })
    }
  }
}

function expectMap(value: unknown, path: string, source: string, lines: Map<string, number>): YamlMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('CONFIG_INVALID', `${path} must be a mapping`, { path: source, line: lines.get(path) })
  }
  return value as YamlMap
}

function expectArray(value: unknown, path: string, source: string, lines: Map<string, number>): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigError('CONFIG_INVALID', `${path} must be an array`, { path: source, line: lines.get(path) })
  }
  return value
}

function expectString(value: unknown, path: string, source: string, lines: Map<string, number>): string {
  if (typeof value !== 'string' || value === '') {
    throw new ConfigError('CONFIG_INVALID', `${path} must be a non-empty string`, { path: source, line: lines.get(path) })
  }
  return value
}

function expectStringMap(value: unknown, path: string, source: string, lines: Map<string, number>): Record<string, string> {
  const map = expectMap(value, path, source, lines)
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(map)) {
    out[key] = expectString(entry, `${path}.${key}`, source, lines)
  }
  return out
}

function expectEnum<T extends string>(value: unknown, allowed: readonly T[], path: string, source: string, lines: Map<string, number>): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ConfigError('CONFIG_INVALID', `${path} must be one of: ${allowed.join(', ')}`, { path: source, line: lines.get(path) })
  }
  return value as T
}

function expectPositiveInt(value: unknown, path: string, source: string, lines: Map<string, number>): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError('CONFIG_INVALID', `${path} must be a positive integer`, { path: source, line: lines.get(path) })
  }
  return value
}

function expectNonNegativeInt(value: unknown, path: string, source: string, lines: Map<string, number>): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError('CONFIG_INVALID', `${path} must be a non-negative integer`, { path: source, line: lines.get(path) })
  }
  return value
}
