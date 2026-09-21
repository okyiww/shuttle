import type { EndpointConfig } from '@shuttle/config'
import { LlmError } from '@shuttle/llm'
import type { GenerateOptions, StreamChunk } from '@shuttle/llm'
import { assertOk, combinedSignal, joinUrl, resolveApiKey } from './http.js'
import { readSseEvents } from './sse.js'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

interface AnthropicEvent {
  type: string
  index?: number
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  content_block?: { type: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string | null
  }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

export async function* streamAnthropicMessages(
  endpoint: EndpointConfig,
  options: GenerateOptions,
): AsyncGenerator<StreamChunk> {
  const provider = options.provider
  const converted = toAnthropicMessages(options.messages)
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: converted.messages,
    stream: true,
  }
  if (converted.system) body.system = converted.system
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }
  if (options.temperature !== undefined) body.temperature = options.temperature

  const response = await fetch(joinUrl(endpoint.baseURL, 'messages'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': resolveApiKey(endpoint, provider),
      'anthropic-version': ANTHROPIC_VERSION,
      ...endpoint.headers,
    },
    body: JSON.stringify(body),
    signal: combinedSignal(options.signal, endpoint.timeoutMs ?? 120_000),
  })
  await assertOk(response, provider)
  if (!response.body) {
    throw new LlmError({ code: 'UNEXPECTED_STATUS', provider, message: 'response has no body' })
  }

  let inputTokens = 0
  let outputTokens = 0
  let stopReason: string | undefined
  const toolNames = new Map<number, string>()

  for await (const payload of readSseEvents(response.body)) {
    let event: AnthropicEvent
    try {
      event = JSON.parse(payload) as AnthropicEvent
    } catch {
      throw new LlmError({
        code: 'PROTOCOL_VIOLATION',
        provider,
        message: `invalid SSE payload: ${payload.slice(0, 200)}`,
      })
    }
    switch (event.type) {
      case 'message_start':
        inputTokens = event.message?.usage?.input_tokens ?? 0
        break
      case 'content_block_start':
        if (event.content_block?.type === 'tool_use' && event.index !== undefined) {
          toolNames.set(event.index, event.content_block.name ?? '')
        }
        break
      case 'content_block_delta': {
        const delta = event.delta
        if (delta?.type === 'text_delta' && delta.text) {
          yield { type: 'text-delta', delta: delta.text }
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'reasoning-delta', delta: delta.thinking }
        } else if (delta?.type === 'input_json_delta') {
          yield {
            type: 'tool-call-delta',
            index: event.index ?? 0,
            name: toolNames.get(event.index ?? 0) || undefined,
            arguments: delta.partial_json ?? '',
          }
        }
        break
      }
      case 'message_delta':
        if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
        break
      case 'error':
        throw mapAnthropicError(event.error, provider)
      default:
        // ping, content_block_stop, message_stop carry no payload we need here.
        break
    }
  }

  yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
  yield { type: 'finish', reason: mapStopReason(stopReason) }
}

function toAnthropicMessages(messages: GenerateOptions['messages']): { system?: string; messages: unknown[] } {
  const systemParts: string[] = []
  const out: unknown[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        systemParts.push(message.content)
        break
      case 'user':
        out.push({ role: 'user', content: message.content })
        break
      case 'assistant': {
        if (!message.toolCalls?.length) {
          out.push({ role: 'assistant', content: message.content })
          break
        }
        const blocks: unknown[] = []
        if (message.content) blocks.push({ type: 'text', text: message.content })
        for (const call of message.toolCalls) {
          let input: unknown = {}
          try {
            input = JSON.parse(call.arguments) as unknown
          } catch {
            input = {}
          }
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input })
        }
        out.push({ role: 'assistant', content: blocks })
        break
      }
      case 'tool':
        out.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }],
        })
        break
    }
  }
  const system = systemParts.join('\n\n')
  return { system: system || undefined, messages: out }
}

function mapStopReason(reason: string | undefined): string {
  if (reason === 'max_tokens') return 'length'
  if (reason === 'tool_use') return 'tool-calls'
  return 'stop'
}

function mapAnthropicError(
  error: { type?: string; message?: string } | undefined,
  provider: string,
): LlmError {
  const type = error?.type ?? 'unknown_error'
  const message = `anthropic stream error (${type}): ${error?.message ?? 'unknown'}`
  if (type.includes('rate_limit') || type.includes('overloaded')) {
    return new LlmError({ code: 'RATE_LIMIT', provider, retryable: true, message })
  }
  if (type.includes('authentication')) {
    return new LlmError({ code: 'AUTH', provider, message })
  }
  if (/context/i.test(error?.message ?? '')) {
    return new LlmError({ code: 'CONTEXT_WINDOW_EXCEEDED', provider, message })
  }
  return new LlmError({ code: 'UNEXPECTED_STATUS', provider, message })
}
