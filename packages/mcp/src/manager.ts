import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig, McpServersConfig } from '@shuttle/config'
import type { Disposer } from '@shuttle/core'
import type { Tool } from '@shuttle/tools'
import { ToolService } from '@shuttle/tools'
import { configKey, sanitizedEnv, validateServerName } from './env.js'
import { beginAuthorization, describeOAuthError, finishAuthorization, OAUTH_FLOW_TIMEOUT_MS } from './oauth-flow.js'
import type { OAuthFlowContext, PendingFlow } from './oauth-flow.js'
import { authStatusOf } from './oauth-provider.js'
import type { McpAuthStatus, ShuttleOAuthProvider } from './oauth-provider.js'
import { ShuttleOAuthProvider as ShuttleOAuthProviderImpl } from './oauth-provider.js'

export type McpServerStatus = 'connected' | 'connecting' | 'error' | 'disabled'

export interface McpToolView {
  /** Full name as registered: `mcp__<serverName>__<rawName>`. */
  name: string
  description: string
  parameters: unknown
}

export interface McpServerView {
  name: string
  transport: 'stdio' | 'streamable-http'
  status: McpServerStatus
  auth: McpAuthStatus
  tools: McpToolView[]
  error?: string
}

export interface ReconnectPolicy {
  initialDelayMs: number
  maxDelayMs: number
  maxAttempts: number
}

const DEFAULT_RECONNECT: ReconnectPolicy = {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
}

interface ServerEntry {
  name: string
  config: McpServerConfig
  status: McpServerStatus
  error?: string
  /** Set when OAuth is required but unavailable (refresh rejected / never authorized). */
  authOverride?: 'unauthorized'
  instructions?: string
  tools: McpToolView[]
  client?: Client
  toolDisposers: Disposer[]
  /** Reconnect attempts since last successful connect. */
  attempts: number
  stopRequested: boolean
  timer?: NodeJS.Timeout
  /** Ring buffer of the child's stderr (last ~2KB), surfaced on errors. */
  stderrTail: string
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content) || content.length === 0) return '(empty tool result)'
  return content
    .map((block) => {
      const record = block as { type?: unknown; text?: unknown }
      return record.type === 'text' && typeof record.text === 'string' ? record.text : JSON.stringify(block)
    })
    .join('\n')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class McpManager {
  private readonly entries = new Map<string, ServerEntry>()
  private readonly providers = new Map<string, ShuttleOAuthProvider>()
  private readonly pendingFlows = new Map<string, PendingFlow>()
  private redirectBase = 'http://127.0.0.1:4080'
  private readonly policy: ReconnectPolicy

  constructor(
    private readonly tools: ToolService,
    options: Partial<ReconnectPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_RECONNECT, ...options }
  }

  /** Loopback base for OAuth callbacks; the api sets this once its port is known. */
  setRedirectBase(base: string): void {
    this.redirectBase = base.replace(/\/+$/, '')
  }

  private providerFor(name: string): ShuttleOAuthProvider {
    let provider = this.providers.get(name)
    if (!provider) {
      provider = new ShuttleOAuthProviderImpl(name, `${this.redirectBase}/api/oauth/callback`)
      this.providers.set(name, provider)
    }
    return provider
  }

  /**
   * Diff desired config against running servers: new ones connect, removed or
   * disabled ones tear down, changed ones reconnect. Writes only land in the
   * user layer; this is invoked from the config hot-reload path.
   */
  applyConfig(mcp: { servers?: McpServersConfig } | undefined): void {
    const desired = mcp?.servers ?? {}
    for (const [name, entry] of [...this.entries]) {
      const next = desired[name]
      if (!next) {
        this.teardown(entry)
        this.entries.delete(name)
        continue
      }
      const changed = configKey(entry.config) !== configKey(next)
      const urlChanged =
        entry.config.transport === 'streamable-http' &&
        next.transport === 'streamable-http' &&
        entry.config.url !== next.url
      const activating = next.disabled !== true && entry.status === 'disabled'
      entry.config = next
      if (next.disabled) {
        this.teardown(entry)
        entry.status = 'disabled'
        entry.error = undefined
        entry.tools = []
      } else {
        if (urlChanged) {
          // A different resource invalidates discovery, registration and tokens.
          void this.providers.get(name)?.invalidateCredentials('all')
          entry.authOverride = undefined
        }
        if (changed || activating) {
          this.teardown(entry)
          this.launch(entry)
        }
      }
    }
    for (const [name, config] of Object.entries(desired)) {
      if (this.entries.has(name)) continue
      validateServerName(name)
      const entry: ServerEntry = {
        name,
        config,
        status: 'connecting',
        tools: [],
        toolDisposers: [],
        attempts: 0,
        stopRequested: false,
        stderrTail: '',
      }
      this.entries.set(name, entry)
      if (config.disabled) {
        entry.status = 'disabled'
      } else {
        this.launch(entry)
      }
    }
  }

  listServers(): McpServerView[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name,
      transport: entry.config.transport,
      status: entry.status,
      auth:
        entry.config.auth === 'oauth'
          ? (entry.authOverride ?? authStatusOf('oauth', this.providers.get(entry.name)))
          : 'n/a',
      tools: entry.tools.map((tool) => ({ ...tool })),
      ...(entry.error ? { error: entry.error } : {}),
    }))
  }

  /**
   * POST /api/mcp/servers/:name/authorize — discovery → DCR → PKCE authorize
   * URL. The caller opens the browser (or hands the URL to the UI); the
   * loopback callback arrives at /api/oauth/callback and completes the flow.
   */
  async authorize(name: string): Promise<{ authorizationUrl: string }> {
    const entry = this.entries.get(name)
    if (!entry) throw new Error(`mcp server not found: ${name}`)
    if (entry.config.transport !== 'streamable-http') {
      throw new Error(`mcp server "${name}" uses stdio — OAuth applies to streamable-http only`)
    }
    if (entry.config.auth !== 'oauth') {
      throw new Error(`mcp server "${name}" has auth: none — set auth: 'oauth' in its config first`)
    }
    const provider = this.providerFor(name)
    const { authorizationUrl, state, flow } = await beginAuthorization(name, entry.config.url, provider)
    const timer = setTimeout(() => {
      this.pendingFlows.delete(state)
    }, OAUTH_FLOW_TIMEOUT_MS)
    timer.unref()
    this.pendingFlows.set(state, {
      ...flow,
      serverName: name,
      state,
      redirectUrl: provider.redirectUrl,
      startedAt: Date.now(),
      timer,
    })
    return { authorizationUrl }
  }

  /**
   * GET /api/oauth/callback — validate state (CSRF), exchange the code, then
   * reconnect the server with fresh tokens.
   */
  async completeAuthorization(state: string, code: string | undefined, oauthError?: string): Promise<string> {
    const flow = this.pendingFlows.get(state)
    if (!flow) {
      throw new Error('unknown or expired OAuth state — start again with POST /api/mcp/servers/:name/authorize')
    }
    this.pendingFlows.delete(state)
    clearTimeout(flow.timer)
    if (oauthError) throw new Error(`authorization rejected by the server: ${oauthError}`)
    if (!code) throw new Error('authorization callback missing code')
    const provider = this.providerFor(flow.serverName)
    try {
      await finishAuthorization(flow, provider, code)
    } catch (error) {
      throw new Error(`token exchange failed: ${describeOAuthError(error)}`)
    }
    const entry = this.entries.get(flow.serverName)
    if (entry && entry.config.disabled !== true) {
      this.teardown(entry)
      this.launch(entry)
    }
    return flow.serverName
  }

  /** Pending authorize URL from the transport-path auth() (for error surfaces). */
  pendingAuthorizationUrl(name: string): string | undefined {
    return this.providers.get(name)?.consumePendingAuthorizationUrl()
  }

  /** Connected servers' instructions, joined for the chat system prompt. */
  getSystemPromptAdditions(): string {
    return [...this.entries.values()]
      .filter((entry) => entry.status === 'connected' && entry.instructions)
      .map((entry) => entry.instructions!)
      .join('\n\n')
  }

  /** Tear down and immediately reconnect a server (web 「重连」 button). */
  reconnect(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) throw new Error(`mcp server not found: ${name}`)
    this.teardown(entry)
    if (entry.config.disabled) {
      entry.status = 'disabled'
    } else {
      this.launch(entry)
    }
  }

  /**
   * Wait until no server is mid-connect (bounded). Lets callers avoid racing
   * the very first request against freshly spawned stdio servers.
   */
  async settle(timeoutMs = 10_000): Promise<void> {
    const started = Date.now()
    for (;;) {
      const busy = [...this.entries.values()].some((entry) => entry.status === 'connecting')
      if (!busy) return
      if (Date.now() - started > timeoutMs) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  async dispose(): Promise<void> {
    for (const flow of this.pendingFlows.values()) clearTimeout(flow.timer)
    this.pendingFlows.clear()
    for (const entry of this.entries.values()) this.teardown(entry)
    this.entries.clear()
  }

  private launch(entry: ServerEntry): void {
    entry.stopRequested = false
    entry.attempts = 0
    entry.status = 'connecting'
    entry.error = undefined
    void this.connect(entry).catch((error) => {
      entry.status = 'error'
      entry.error = describe(error)
    })
  }

  private async connect(entry: ServerEntry): Promise<void> {
    const client = new Client({ name: 'shuttle', version: '0.0.0' }, { capabilities: {} })
    const transport = createTransport(
      entry.config,
      entry,
      entry.config.auth === 'oauth' ? this.providerFor(entry.name) : undefined,
    )
    try {
      client.onclose = () => {
        if (!entry.stopRequested && entry.client === client) this.handleDisconnect(entry)
      }
      entry.client = client
      await client.connect(transport) // initialize handshake
      if (entry.stopRequested || entry.client !== client) {
        await client.close().catch(() => undefined)
        return
      }
      const listed = await client.listTools()
      if (entry.stopRequested || entry.client !== client) {
        await client.close().catch(() => undefined)
        return
      }
      this.swapTools(entry, listed.tools ?? [])
      entry.instructions = client.getInstructions()
      entry.status = 'connected'
      entry.error = undefined
      entry.authOverride = undefined
      entry.attempts = 0
    } catch (error) {
      if (entry.stopRequested || entry.client !== client) return
      const stderrNote = entry.stderrTail.trim() ? ` — server stderr: ${entry.stderrTail.trim().slice(-300)}` : ''
      entry.status = 'error'
      entry.error = `${describe(error)}${stderrNote}`
      await client.close().catch(() => undefined)
      if (entry.client === client) entry.client = undefined
      // Missing/rejected authorization is not retryable — surface it and wait
      // for the user to authorize via the API flow (POST .../authorize).
      if (isUnauthorized(error)) {
        entry.authOverride = 'unauthorized'
        entry.error = `${entry.error} — re-authorize via POST /api/mcp/servers/${entry.name}/authorize`
        return
      }
      this.scheduleReconnect(entry)
    }
  }

  /** Connection lost after being established: keep the old tool generation. */
  private handleDisconnect(entry: ServerEntry): void {
    if (entry.stopRequested) return
    if (entry.status === 'connected') {
      entry.status = 'error'
      entry.error = 'connection closed'
    }
    this.scheduleReconnect(entry)
  }

  private scheduleReconnect(entry: ServerEntry): void {
    if (entry.stopRequested) return
    if (entry.authOverride === 'unauthorized') return // reconnection cannot fix auth
    if (entry.attempts >= this.policy.maxAttempts) {
      entry.status = 'error'
      entry.error = `${entry.error ?? 'connection failed'} (gave up after ${this.policy.maxAttempts} attempts)`
      return
    }
    const delay = Math.min(this.policy.maxDelayMs, this.policy.initialDelayMs * 2 ** entry.attempts)
    entry.attempts += 1
    entry.timer = setTimeout(() => {
      if (entry.stopRequested) return
      if (entry.client) return // already reconnected by another path
      entry.status = 'connecting'
      void this.connect(entry).catch((error) => {
        if (!entry.stopRequested) {
          entry.status = 'error'
          entry.error = describe(error)
        }
      })
    }, delay)
    entry.timer.unref()
  }

  /** Replace the registered tool set atomically — never a half-updated list. */
  private swapTools(entry: ServerEntry, tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): void {
    const views = tools.map((tool) => ({
      raw: tool.name,
      fullName: `mcp__${entry.name}__${tool.name}`,
      view: {
        name: `mcp__${entry.name}__${tool.name}`,
        description: tool.description ?? '',
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      } as McpToolView,
    }))
    // Fail loud before mutating anything: a name owned by someone else
    // (or duplicated inside this list) must not leave a half-updated set.
    const owned = new Set(entry.tools.map((tool) => tool.name))
    const seen = new Set<string>()
    for (const { fullName } of views) {
      if (seen.has(fullName) || (this.tools.has(fullName) && !owned.has(fullName))) {
        throw new Error(`mcp tool name collision: ${fullName}`)
      }
      seen.add(fullName)
    }
    for (const dispose of entry.toolDisposers) dispose()
    entry.toolDisposers = []
    entry.tools = []
    for (const { raw, view } of views) {
      const disposer = this.tools.register({
        name: view.name,
        description: view.description,
        parameters: view.parameters,
        execute: (args) => this.callTool(entry, raw, args),
      })
      entry.toolDisposers.push(disposer)
      entry.tools.push(view)
    }
  }

  private async callTool(entry: ServerEntry, rawName: string, args: Record<string, unknown>): Promise<string> {
    const client = entry.client
    if (!client || entry.status !== 'connected') {
      throw new Error(`mcp server "${entry.name}" is not connected`)
    }
    const timeoutMs = entry.config.toolCallTimeoutMs
    const request = client.callTool({ name: rawName, arguments: args })
    const result = timeoutMs
      ? await withTimeout(request, timeoutMs, `callTool ${entry.name}/${rawName}`)
      : await request
    const text = textOf(result)
    if (result.isError) throw new Error(text)
    return text
  }

  private teardown(entry: ServerEntry): void {
    entry.stopRequested = true
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    const client = entry.client
    entry.client = undefined
    if (client) void client.close().catch(() => undefined)
    for (const dispose of entry.toolDisposers) dispose()
    entry.toolDisposers = []
    entry.tools = []
    entry.instructions = undefined
    if (entry.status !== 'disabled') entry.status = 'connecting'
    entry.error = undefined
  }
}

function createTransport(
  config: McpServerConfig,
  entry: ServerEntry,
  oauthProvider?: ShuttleOAuthProvider,
): Transport {
  if (config.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd,
      env: { ...sanitizedEnv(), ...config.env },
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk: unknown) => {
      entry.stderrTail = `${entry.stderrTail}${String(chunk)}`.slice(-2048)
    })
    return transport
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
    ...(config.auth === 'oauth' && oauthProvider ? { authProvider: oauthProvider } : {}),
  })
}

function isUnauthorized(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true
  const code = (error as { errorCode?: unknown }).errorCode
  if (code === 'invalid_grant' || code === 'invalid_token' || code === 'invalid_client') return true
  const message = error instanceof Error ? error.message : String(error)
  return /invalid_grant|invalid_token|unauthorized|Unauthorized/.test(message)
}
