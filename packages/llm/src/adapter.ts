import type { GenerateOptions, ProviderInfo, ResolvedModel, StreamChunk } from './types.js'

/**
 * Provider-neutral adapter contract. Wire code lives exclusively in adapter
 * packages (e.g. @shuttle/llm-openai); this package stays transport-free.
 */
export abstract class LlmAdapter {
  abstract info(provider: string): ProviderInfo
  abstract resolveModel(provider: string, model: string): ResolvedModel
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
