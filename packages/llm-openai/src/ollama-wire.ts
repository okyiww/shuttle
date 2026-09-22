import type { EndpointConfig } from '@shuttle/config'
import { LlmError } from '@shuttle/llm'
import type { FinishReason, GenerateOptions, StreamChunk, ToolCall } from '@shuttle/llm'
import { assertOk, combinedSignal, joinUrl } from './http.js'
import { readNdjsonLines } from './ndjson.js'

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'

interface OllamaToolCall {
  index?: number
  function?: { name?: string; arguments?: unknown }
}

interface OllamaChatLine {
  message?: {
    role?: string
    content?: string
    thinking?: string
    tool_calls?: OllamaToolCall[]
  }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
}

export async function* streamOllamaChat(
  endpoint: EndpointConfig,
  options: GenerateOptions,
): AsyncGenerator<StreamChunk> {
  const provider = options.provider
  const body: Record<string, unknown> = {
    model: options.model,
    messages: toOllamaMessages(options.messages),
    stream: true,
    think: true,
  }
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  const ollamaOptions: Record<string, unknown> = {}
  if (options.temperature !== undefined) ollamaOptions.temperature = options.temperature
  if (options.maxTokens !== undefined) ollamaOptions.num_predict = options.maxTokens
  if (Object.keys(ollamaOptions).length > 0) body.options = ollamaOptions

  const response = await fetch(joinUrl(endpoint.baseURL || DEFAULT_OLLAMA_BASE_URL, 'api/chat'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...endpoint.headers,
    },
    body: JSON.stringify(body),
    signal: combinedSignal(options.signal, endpoint.timeoutMs ?? 120_000),
  })
  await assertOk(response, provider)
  if (!response.body) {
    throw new LlmError({ code: 'UNEXPECTED_STATUS', provider, message: 'response has no body' })
  }

  let sawToolCalls = false
  let sawDone = false
  let inputTokens = 0
  let outputTokens = 0
  let doneReason: string | undefined

  for await (const line of readNdjsonLines(response.body)) {
    let event: OllamaChatLine
    try {
      event = JSON.parse(line) as OllamaChatLine
    } catch {
      throw new LlmError({
        code: 'PROTOCOL_VIOLATION',
        provider,
        message: `invalid NDJSON payload: ${line.slice(0, 200)}`,
      })
    }
    const message = event.message
    if (message?.thinking) yield { type: 'reasoning-delta', delta: message.thinking }
    if (message?.content) yield { type: 'text-delta', delta: message.content }
    if (message?.tool_calls) {
      for (const toolCall of message.tool_calls) {
        sawToolCalls = true
        yield {
          type: 'tool-call-delta',
          index: toolCall.index ?? 0,
          name: toolCall.function?.name,
          arguments: stringifyArguments(unwrapSchemaFilling(toolCall.function?.arguments)),
        }
      }
    }
    if (event.done) {
      sawDone = true
      doneReason = event.done_reason
      inputTokens = event.prompt_eval_count ?? 0
      outputTokens = event.eval_count ?? 0
    }
  }

  if (!sawDone) {
    throw new LlmError({
      code: 'PROTOCOL_VIOLATION',
      provider,
      message: 'ollama stream ended without a done line',
    })
  }
  yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
  yield { type: 'finish', reason: mapDoneReason(doneReason, sawToolCalls) }
}

function toOllamaMessages(messages: GenerateOptions['messages']): unknown[] {
  const out: unknown[] = []
  // Ollama tool results carry `name` instead of a tool_call_id, so the latest
  // assistant toolCalls map the toolCallId back to its name.
  let pendingToolCalls: ToolCall[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: message.content })
        break
      case 'user': {
        const entry: Record<string, unknown> = { role: 'user', content: message.content }
        if (message.images?.length) {
          entry.images = message.images.map((dataUrl) => dataUrl.replace(/^data:[^,]*,/, ''))
        }
        out.push(entry)
        break
      }
      case 'assistant': {
        const entry: Record<string, unknown> = { role: 'assistant', content: message.content }
        if (message.toolCalls?.length) {
          entry.tool_calls = message.toolCalls.map((call) => ({
            function: { name: call.name, arguments: parseArguments(call.arguments) },
          }))
          pendingToolCalls = message.toolCalls
        }
        out.push(entry)
        break
      }
      case 'tool': {
        const name = pendingToolCalls.find((call) => call.id === message.toolCallId)?.name ?? message.toolCallId
        out.push({ role: 'tool', name, content: message.content })
        break
      }
    }
  }
  return out
}

function parseArguments(arguments_: string): unknown {
  try {
    return JSON.parse(arguments_) as unknown
  } catch {
    return arguments_
  }
}

function stringifyArguments(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value)
}

const SCHEMA_TYPE_NAMES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])

/**
 * Qwen3 的工具参数按 JSON Schema 填充方式输出：`{"jql": {"type": "string",
 * "value": "..."}}`。恰好只含 type/value 且 type 是 schema 类型名的对象
 * 折叠为 value 本体（Qwen 官方解析器同款后处理）。
 */
function unwrapSchemaFilling(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrapSchemaFilling)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Object.keys(record).length === 2 && typeof record.type === 'string' &&
        SCHEMA_TYPE_NAMES.has(record.type) && 'value' in record) {
      return unwrapSchemaFilling(record.value)
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, unwrapSchemaFilling(entry)]))
  }
  return value
}

function mapDoneReason(doneReason: string | undefined, sawToolCalls: boolean): FinishReason {
  if (sawToolCalls) return 'tool-calls'
  if (doneReason === 'length') return 'length'
  if (doneReason === 'stop' || doneReason === undefined) return 'stop'
  return doneReason
}
