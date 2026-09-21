import type { Context, Disposer } from '@shuttle/core'
import { LlmAdapter } from './adapter.js'
import { LlmError } from './errors.js'
import type { GenerateOptions, StreamChunk } from './types.js'

declare module '@shuttle/core' {
  interface ShuttleServiceMap {
    llm: LlmService
  }
}

export class LlmService {
  private readonly adapters = new Map<string, LlmAdapter>()

  constructor(readonly ctx?: Context) {}

  /** Register one adapter under one or more route names. Duplicate route -> DUPLICATE_ADAPTER. */
  registerAdapter(routes: string[], adapter: LlmAdapter): Disposer {
    for (const route of routes) {
      if (this.adapters.has(route)) {
        throw new LlmError({
          code: 'DUPLICATE_ADAPTER',
          provider: route,
          message: `an adapter is already registered for route: ${route}`,
        })
      }
    }
    for (const route of routes) {
      this.adapters.set(route, adapter)
    }
    let removed = false
    return () => {
      if (removed) return
      removed = true
      for (const route of routes) {
        if (this.adapters.get(route) === adapter) this.adapters.delete(route)
      }
    }
  }

  resolve(provider: string): LlmAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) {
      throw new LlmError({
        code: 'NO_ADAPTER',
        provider,
        message: `no adapter registered for provider: ${provider}`,
      })
    }
    return adapter
  }

  /**
   * Delegate to the adapter and enforce the StreamChunk protocol:
   * usage before finish, finish unique and terminal, and a completed stream
   * always ends with finish.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const adapter = this.resolve(options.provider)
    let seenUsage = false
    let finished = false
    for await (const chunk of adapter.stream(options)) {
      if (finished) {
        throw new LlmError({
          code: 'PROTOCOL_VIOLATION',
          provider: options.provider,
          message: `adapter emitted a chunk after finish: ${chunk.type}`,
        })
      }
      if (chunk.type === 'usage') seenUsage = true
      if (chunk.type === 'finish') {
        if (!seenUsage) {
          throw new LlmError({
            code: 'PROTOCOL_VIOLATION',
            provider: options.provider,
            message: 'adapter emitted finish before usage',
          })
        }
        finished = true
      }
      yield chunk
    }
    if (!finished) {
      throw new LlmError({
        code: 'PROTOCOL_VIOLATION',
        provider: options.provider,
        message: 'adapter stream ended without a finish chunk',
      })
    }
  }
}
