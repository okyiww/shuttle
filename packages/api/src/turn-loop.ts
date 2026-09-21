import type { LlmService } from '@shuttle/llm'
import type { Message, StreamChunk, Usage } from '@shuttle/llm'
import type { SessionStore } from '@shuttle/session'
import type { AskDecision, ToolService } from '@shuttle/tools'

export interface ToolCallRequest {
  id: string
  name: string
  arguments: string
}

export interface TurnLoopDeps {
  llm: LlmService
  tools: ToolService
  session: SessionStore
  provider: string
  model: string
  systemPrompt?: string
  signal?: AbortSignal
  /** Safety bound; the loop ends earlier once the model stops calling tools. */
  maxSteps?: number
  /** e.g. wait for MCP servers to finish connecting before step 1. */
  waitForTools?: () => Promise<void>
}

export interface TurnLoopEvents {
  onChunk?: (chunk: StreamChunk) => void
  onToolCall?: (call: ToolCallRequest) => void
  onToolResult?: (call: ToolCallRequest, result: { ok: boolean; content: string }) => void
  /** Decides guard-'ask' tools; absent → deny. */
  onAsk?: (call: ToolCallRequest) => Promise<AskDecision> | AskDecision
}

export interface TurnLoopOutcome {
  text: string
  reasoning: string
  usage?: Usage
  finishReason?: string
  steps: number
}

const MAX_TOOL_CONCURRENCY = 10

/**
 * One turn = zero or more steps (dsh terminology): a step is one model
 * request plus the tool calls it makes; the loop ends when there is no
 * tool debt. History is re-derived from the session log before every step —
 * never assembled twice, always model-visible ⟺ logged.
 */
export async function runTurnLoop(deps: TurnLoopDeps, events: TurnLoopEvents = {}): Promise<TurnLoopOutcome> {
  const maxSteps = deps.maxSteps ?? 20
  await deps.waitForTools?.()
  let outcome: TurnLoopOutcome | undefined
  for (let step = 1; step <= maxSteps; step++) {
    const messages = deps.session.deriveMessages()
    const requestMessages: Message[] = deps.systemPrompt
      ? [{ role: 'system', content: deps.systemPrompt }, ...messages]
      : messages

    let text = ''
    let reasoning = ''
    let usage: Usage | undefined
    let finishReason: string | undefined
    const toolCalls = new Map<number, { name?: string; arguments: string }>()

    for await (const chunk of deps.llm.stream({
      provider: deps.provider,
      model: deps.model,
      messages: requestMessages,
      tools: deps.tools.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      purpose: 'chat',
      signal: deps.signal,
    })) {
      events.onChunk?.(chunk)
      if (chunk.type === 'text-delta') text += chunk.delta
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.delta
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finishReason = chunk.reason
      else if (chunk.type === 'tool-call-delta') {
        const slot = toolCalls.get(chunk.index) ?? { arguments: '' }
        if (chunk.name !== undefined) slot.name = chunk.name
        slot.arguments += chunk.arguments
        toolCalls.set(chunk.index, slot)
      }
    }

    const calls: ToolCallRequest[] = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, slot]) => ({ id: `call_${step}_${index}`, name: slot.name ?? '', arguments: slot.arguments }))
    outcome = { text, reasoning, usage, finishReason, steps: step }

    if (calls.length === 0) {
      deps.session.append({
        type: 'assistant/message',
        message: { role: 'assistant', content: text, ...(reasoning === '' ? {} : { reasoning }) },
      })
      return outcome
    }

    for (const call of calls) {
      if (call.name === '') {
        throw new Error(`model emitted a tool call without a name (step ${step})`)
      }
    }
    deps.session.append({
      type: 'assistant/message',
      message: {
        role: 'assistant',
        content: text,
        toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      },
    })
    await executeCalls(deps, events, calls)
  }
  throw new Error(`turn exceeded maxSteps (${maxSteps})`)
}

async function executeCalls(deps: TurnLoopDeps, events: TurnLoopEvents, calls: ToolCallRequest[]): Promise<void> {
  const queue = [...calls]
  const workers = Array.from({ length: Math.min(MAX_TOOL_CONCURRENCY, calls.length) }, async () => {
    for (;;) {
      const call = queue.shift()
      if (!call) return
      deps.session.append({ type: 'tool/call', toolCallId: call.id, name: call.name, arguments: call.arguments })
      events.onToolCall?.(call)
      if (!deps.tools.has(call.name)) {
        // Transient: server still connecting. Feed it back to the model
        // instead of crashing the turn; the next step re-lists tools.
        const content = `tool not registered: ${call.name} (server may still be connecting)`
        deps.session.append({ type: 'tool/result', toolCallId: call.id, content })
        events.onToolResult?.(call, { ok: false, content })
        continue
      }
      let args: Record<string, unknown>
      try {
        args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
      } catch (error) {
        const content = `invalid tool arguments JSON: ${error instanceof Error ? error.message : String(error)}`
        deps.session.append({ type: 'tool/result', toolCallId: call.id, content })
        events.onToolResult?.(call, { ok: false, content })
        continue
      }
      const result = await deps.tools.executeTool(call.name, args, {
        onAsk: () => (events.onAsk ? events.onAsk(call) : 'deny'),
        signal: deps.signal,
      })
      deps.session.append({ type: 'tool/result', toolCallId: call.id, content: result.content })
      events.onToolResult?.(call, result)
    }
  })
  await Promise.all(workers)
}
