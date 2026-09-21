import type { EndpointConfig } from '@shuttle/config'
import { LlmError } from '@shuttle/llm'
import type { FinishReason, GenerateOptions, Message, StreamChunk } from '@shuttle/llm'
import { assertOk, combinedSignal, joinUrl, resolveApiKey } from './http.js'
import { readSseEvents } from './sse.js'

interface OpenAiToolCallDelta {
  index: number
  function?: { name?: string; arguments?: string }
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: OpenAiToolCallDelta[]
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export async function* streamOpenAiChatCompletions(
  endpoint: EndpointConfig,
  options: GenerateOptions,
): AsyncGenerator<StreamChunk> {
  const provider = options.provider
  const compat = endpoint.compat ?? {}
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages.map((message) => toOpenAiMessage(message, compat.systemRole ?? 'system')),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body[compat.maxTokensField ?? 'max_tokens'] = options.maxTokens
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  if (compat.thinkingFormat === 'deepseek' && options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort
  }

  const response = await fetch(joinUrl(endpoint.baseURL, 'chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${resolveApiKey(endpoint, provider)}`,
      ...endpoint.headers,
    },
    body: JSON.stringify(body),
    signal: combinedSignal(options.signal, endpoint.timeoutMs ?? 120_000),
  })
  await assertOk(response, provider)
  if (!response.body) {
    throw new LlmError({ code: 'UNEXPECTED_STATUS', provider, message: 'response has no body' })
  }

  // Gateways emit finish_reason before the usage-only final chunk, so the
  // finish chunk is held back until the stream ends — LlmService requires
  // usage strictly before finish.
  let pendingFinish: FinishReason | undefined
  for await (const payload of readSseEvents(response.body)) {
    if (payload === '[DONE]') break
    let chunk: OpenAiStreamChunk
    try {
      chunk = JSON.parse(payload) as OpenAiStreamChunk
    } catch {
      throw new LlmError({
        code: 'PROTOCOL_VIOLATION',
        provider,
        message: `invalid SSE payload: ${payload.slice(0, 200)}`,
      })
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta?.content) yield { type: 'text-delta', delta: delta.content }
    const reasoning = delta?.reasoning_content ?? delta?.reasoning
    if (reasoning) yield { type: 'reasoning-delta', delta: reasoning }
    if (delta?.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        yield {
          type: 'tool-call-delta',
          index: toolCall.index,
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments ?? '',
        }
      }
    }
    if (chunk.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens,
        },
      }
    }
    if (choice?.finish_reason) pendingFinish = mapFinishReason(choice.finish_reason)
  }
  if (pendingFinish === undefined) {
    throw new LlmError({
      code: 'PROTOCOL_VIOLATION',
      provider,
      message: 'provider stream ended without finish_reason',
    })
  }
  yield { type: 'finish', reason: pendingFinish }
}

function toOpenAiMessage(message: Message, systemRole: 'system' | 'developer'): unknown {
  switch (message.role) {
    case 'system':
      return { role: systemRole, content: message.content }
    case 'user':
      return { role: 'user', content: message.content }
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
    case 'assistant': {
      const out: Record<string, unknown> = { role: 'assistant', content: message.content }
      if (message.reasoning) out.reasoning_content = message.reasoning
      if (message.toolCalls?.length) {
        out.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      }
      return out
    }
  }
}

function mapFinishReason(reason: string): FinishReason {
  if (reason === 'stop') return 'stop'
  if (reason === 'length') return 'length'
  if (reason === 'tool_calls') return 'tool-calls'
  return reason
}
