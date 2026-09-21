/** A tool invocation requested by the model; `arguments` stays a raw JSON string. */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** One model-visible message. `system` must be the leading system message. */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; toolCallId: string; content: string }

/** JSON Schema for tool parameters. */
export interface ToolSchema {
  name: string
  description?: string
  parameters?: unknown
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
}

export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'error' | (string & {})

/**
 * Wire protocol, verbatim from the Shuttle README. `finish` is the unique
 * terminal chunk and a `usage` chunk must be emitted before it.
 */
export type StreamChunk =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call-delta'; index: number; name?: string; arguments: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

export interface GenerateOptions {
  provider: string
  model: string
  messages: Message[]
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** Free-form caller metadata (logging / cost attribution); adapters may ignore it. */
  purpose?: string
  /** DeepSeek-style thinking effort; passed through as `reasoning_effort` when the endpoint compat enables it. */
  reasoningEffort?: string
}

export interface ModelInfo {
  id: string
  contextWindow?: number
}

export interface ProviderInfo {
  provider: string
  api?: string
  models: ModelInfo[]
}

export interface ResolvedModel {
  id: string
  contextWindow?: number
}
