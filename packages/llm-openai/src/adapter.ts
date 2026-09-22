import { ConfigError } from '@shuttle/config'
import type { EndpointConfig } from '@shuttle/config'
import { LlmAdapter, LlmError } from '@shuttle/llm'
import type { GenerateOptions, ProviderInfo, ResolvedModel, StreamChunk } from '@shuttle/llm'
import { DEFAULT_TIMEOUT_MS, sleep } from './http.js'
import { streamAnthropicMessages } from './anthropic-wire.js'
import { streamOllamaChat } from './ollama-wire.js'
import { streamOpenAiChatCompletions } from './openai-wire.js'

export interface OpenAiCompatibleAdapterOptions {
  /** Route names (= provider names) mapped to their endpoint config. */
  providers: Record<string, EndpointConfig>
}

const API_VALUES = ['openai-completions', 'anthropic-messages', 'ollama'] as const

/**
 * The single model package Shuttle needs. One adapter instance owns a whole
 * endpoint directory; `api` on each endpoint picks the wire.
 */
export class OpenAiCompatibleAdapter extends LlmAdapter {
  private readonly endpoints: Record<string, EndpointConfig>

  constructor(options: OpenAiCompatibleAdapterOptions) {
    super()
    for (const [name, endpoint] of Object.entries(options.providers)) {
      validateEndpoint(name, endpoint)
    }
    this.endpoints = { ...options.providers }
  }

  override info(provider: string): ProviderInfo {
    const endpoint = this.endpointFor(provider)
    return { provider, api: endpoint.api, models: endpoint.models ?? [] }
  }

  override resolveModel(provider: string, model: string): ResolvedModel {
    const endpoint = this.endpointFor(provider)
    const found = endpoint.models?.find((entry) => entry.id === model)
    return found ? { id: found.id, contextWindow: found.contextWindow } : { id: model }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const endpoint = this.endpointFor(options.provider)
    const retries = endpoint.retryPolicy?.retries ?? 2
    const backoffMs = endpoint.retryPolicy?.backoffMs ?? 1000
    let attempt = 0
    for (;;) {
      const wire =
        endpoint.api === 'anthropic-messages'
          ? streamAnthropicMessages(endpoint, options)
          : endpoint.api === 'ollama'
            ? streamOllamaChat(endpoint, options)
            : streamOpenAiChatCompletions(endpoint, options)
      const iterator = wire[Symbol.asyncIterator]()
      let emitted = false
      let modelVisible = false
      let tail: StreamChunk[] = []
      try {
        for (;;) {
          const { done, value } = await iterator.next()
          if (done) break
          emitted = true
          if (value.type === 'text-delta' || value.type === 'tool-call-delta') modelVisible = true
          if (value.type === 'usage' || value.type === 'finish') {
            // usage→finish 是协议尾部（finish 唯一且终止）。缓冲到流结束再放行：
            // 空响应重试时不能把 finish 先放出去——下游 LlmService 见到 finish
            // 后再收 chunk 即 PROTOCOL_VIOLATION。
            tail.push(value)
            continue
          }
          yield value
        }
        // dsh llm-retry 语义：wire 合法完成但没有任何正文/工具输出视为
        // EMPTY_RESPONSE，重发同一请求（仅 reasoning 的输出可安全重做）。
        if (!modelVisible) {
          throw new LlmError({
            code: 'EMPTY_RESPONSE',
            provider: options.provider,
            retryable: true,
            message: 'model completed with no text and no tool calls',
          })
        }
        yield* tail
        return
      } catch (error) {
        try {
          await iterator.return?.(undefined)
        } catch {
          // The wire is already broken; preserve the original error.
        }
        if (options.signal?.aborted) throw error
        const mapped = normalizeError(error, options.provider)
        // EMPTY_RESPONSE 只看模型可见输出；其余错误保持"首 chunk 后不重试"。
        const irreversible = mapped.code === 'EMPTY_RESPONSE' ? modelVisible : emitted
        if (irreversible || attempt >= retries || !isRetryable(mapped)) throw mapped
        attempt++
        const delay = backoffMs * 2 ** (attempt - 1) + Math.random() * 100
        await sleep(delay, options.signal)
      }
    }
  }

  private endpointFor(provider: string): EndpointConfig {
    const endpoint = this.endpoints[provider]
    if (!endpoint) {
      throw new LlmError({
        code: 'NO_ADAPTER',
        provider,
        message: `no endpoint configured for provider: ${provider}`,
      })
    }
    return endpoint
  }
}

/** AUTH / RATE_LIMIT / 5xx / network / EMPTY_RESPONSE 可重试（dsh llm-retry 语义）. */
function isRetryable(error: LlmError): boolean {
  if (error.code === 'AUTH' || error.code === 'RATE_LIMIT') return true
  if (error.code === 'EMPTY_RESPONSE') return true
  return error.code === 'UNEXPECTED_STATUS' && error.retryable
}

function normalizeError(error: unknown, provider: string): LlmError {
  if (error instanceof LlmError) return error
  const name = (error as { name?: string } | undefined)?.name
  if (name === 'TimeoutError') {
    return new LlmError({
      code: 'UNEXPECTED_STATUS',
      provider,
      retryable: true,
      message: `request timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      cause: error,
    })
  }
  return new LlmError({
    code: 'UNEXPECTED_STATUS',
    provider,
    retryable: true,
    message: `network or wire error: ${(error as Error)?.message ?? String(error)}`,
    cause: error,
  })
}

function validateEndpoint(name: string, endpoint: EndpointConfig): void {
  const where = `endpoints.${name}`
  if (!endpoint || typeof endpoint !== 'object') {
    throw new ConfigError('CONFIG_INVALID', `${where} must be a mapping`)
  }
  if (endpoint.api !== undefined && !(API_VALUES as readonly string[]).includes(endpoint.api)) {
    throw new ConfigError('CONFIG_INVALID', `${where}.api must be one of: ${API_VALUES.join(', ')}`)
  }
  // ollama endpoints may omit baseURL; the wire falls back to localhost.
  if (endpoint.api !== 'ollama' && (typeof endpoint.baseURL !== 'string' || endpoint.baseURL === '')) {
    throw new ConfigError('CONFIG_INVALID', `${where}.baseURL must be a non-empty string`)
  }
  if (endpoint.apiKeyEnv !== undefined && (typeof endpoint.apiKeyEnv !== 'string' || endpoint.apiKeyEnv === '')) {
    throw new ConfigError('CONFIG_INVALID', `${where}.apiKeyEnv must be a non-empty string`)
  }
}
