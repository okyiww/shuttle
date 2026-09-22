export type LlmErrorCode =
  | 'MISSING_CREDENTIAL'
  | 'NO_ADAPTER'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'UNEXPECTED_STATUS'
  | 'PROTOCOL_VIOLATION'
  | 'DUPLICATE_ADAPTER'
  /** Wire-valid completion with no text and no tool calls (模型弃权); dsh llm-retry 语义. */
  | 'EMPTY_RESPONSE'

/** Unified provider-neutral LLM failure. `retryable` is a hint for the retry policy. */
export class LlmError extends Error {
  readonly code: LlmErrorCode
  readonly provider: string
  readonly retryable: boolean
  /** For MISSING_CREDENTIAL: the env var that must be set. */
  readonly credentialEnv?: string

  constructor(init: {
    code: LlmErrorCode
    provider: string
    message: string
    retryable?: boolean
    credentialEnv?: string
    cause?: unknown
  }) {
    super(init.message, { cause: init.cause })
    this.name = 'LlmError'
    this.code = init.code
    this.provider = init.provider
    this.retryable = init.retryable ?? false
    this.credentialEnv = init.credentialEnv
  }
}

export function isLlmError(error: unknown): error is LlmError {
  return error instanceof LlmError
}
