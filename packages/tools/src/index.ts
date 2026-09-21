import type { Context, Disposer } from '@shuttle/core'

export type ToolErrorCode = 'DUPLICATE_TOOL' | 'MISSING_TOOL'

export class ToolError extends Error {
  readonly code: ToolErrorCode

  constructor(code: ToolErrorCode, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

export type GuardAction = 'allow' | 'ask' | 'deny'

/** Guard policy (structurally compatible with @shuttle/config's GuardPolicy). */
export interface GuardPolicy {
  /** Longest prefix match on the tool name wins (e.g. `mcp__jira__`). */
  prefix: string
  action: GuardAction
}

export interface ToolGate {
  tool: string
  args: Record<string, unknown>
  action: GuardAction
  reason?: string
}

export interface ToolResult {
  ok: boolean
  content: string
  /** Set when the caller approved via an 'ask' gate and asked to remember. */
  remember?: boolean
}

export interface Tool {
  name: string
  description: string
  /** JSON Schema object, passed through to the model verbatim. */
  parameters: unknown
  execute: (args: Record<string, unknown>, context: { signal?: AbortSignal }) => Promise<string> | string
}

export type AskDecision = 'allow' | 'deny' | 'allow-remember'

export interface ExecuteOptions {
  /**
   * Decides guard-'ask' tools. The API layer suspends the loop for an
   * approval; the CLI answers automatically. Absent → deny.
   */
  onAsk?: (tool: string, args: Record<string, unknown>) => Promise<AskDecision> | AskDecision
  signal?: AbortSignal
}

declare module '@shuttle/core' {
  interface ShuttleServiceMap {
    tools: ToolService
  }
  interface ShuttleWaterfallMap {
    /** Guard gate, resolved from config policies then offered to listeners. */
    'tools/pre-execute': ToolGate
  }
}

/** Resolve the guard action for a tool name: longest prefix match, default allow. */
export function resolveGuardAction(policies: readonly GuardPolicy[] | undefined, tool: string): GuardAction {
  let best: GuardPolicy | undefined
  for (const policy of policies ?? []) {
    if (!tool.startsWith(policy.prefix)) continue
    if (!best || policy.prefix.length > best.prefix.length) best = policy
  }
  return best?.action ?? 'allow'
}

export class ToolService {
  private readonly tools = new Map<string, Tool>()

  constructor(readonly ctx?: Context) {}

  register(tool: Tool): Disposer {
    if (this.tools.has(tool.name)) {
      throw new ToolError('DUPLICATE_TOOL', `tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name)
    }
  }

  resolve(name: string): Tool {
    const tool = this.tools.get(name)
    if (!tool) throw new ToolError('MISSING_TOOL', `tool not registered: ${name}`)
    return tool
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Every registered tool as model-facing schemas. */
  list(): Tool[] {
    return [...this.tools.values()]
  }

  /** Configured policies: read live from the `config` service when present. */
  policies(): GuardPolicy[] {
    try {
      const loaded = this.ctx?.get('config') as
        | { config?: { tools?: { guard?: { policies?: GuardPolicy[] } } } }
        | undefined
      return loaded?.config?.tools?.guard?.policies ?? []
    } catch {
      return []
    }
  }

  /**
   * Guard + execute. Errors from the tool body are captured into
   * `{ ok: false, content }` — a throwing tool must never crash the loop.
   */
  async executeTool(name: string, args: Record<string, unknown>, options: ExecuteOptions = {}): Promise<ToolResult> {
    const tool = this.resolve(name)
    let gate: ToolGate = { tool: name, args, action: resolveGuardAction(this.policies(), name) }
    if (this.ctx) {
      gate = await this.ctx.waterfall('tools/pre-execute', gate)
    }
    if (gate.action === 'deny') {
      return { ok: false, content: `工具调用被 guard 拒绝${gate.reason ? `：${gate.reason}` : ''}` }
    }
    if (gate.action === 'ask') {
      const decision = options.onAsk ? await options.onAsk(name, args) : 'deny'
      if (decision !== 'allow' && decision !== 'allow-remember') {
        return { ok: false, content: `工具调用 ${name} 未获授权（用户拒绝或无人审批）` }
      }
      const content = await this.run(tool, args, options.signal)
      return { ok: true, content, remember: decision === 'allow-remember' }
    }
    try {
      return { ok: true, content: await this.run(tool, args, options.signal) }
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) }
    }
  }

  private async run(tool: Tool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const output = await tool.execute(args, { signal })
    return typeof output === 'string' ? output : JSON.stringify(output)
  }
}
