/**
 * Typed event maps, extended by consumers via declaration merging:
 *
 * ```ts
 * declare module '@shuttle/core' {
 *   interface ShuttleEventMap { 'config/changed': [config: LoadedConfig] }
 *   interface ShuttleWaterfallMap { 'llm/request': GenerateOptions }
 * }
 * ```
 */
export interface ShuttleEventMap {}

export interface ShuttleWaterfallMap {}

export type EventArgs<K extends keyof ShuttleEventMap> = ShuttleEventMap[K] extends unknown[]
  ? ShuttleEventMap[K]
  : never

export type EventListener<K extends keyof ShuttleEventMap> = (...args: EventArgs<K>) => unknown

export type WaterfallValue<K extends keyof ShuttleWaterfallMap> = ShuttleWaterfallMap[K]

export type WaterfallNext<K extends keyof ShuttleWaterfallMap> = (
  value: ShuttleWaterfallMap[K],
) => Promise<ShuttleWaterfallMap[K]>

export type WaterfallListener<K extends keyof ShuttleWaterfallMap> = (
  value: ShuttleWaterfallMap[K],
  next: WaterfallNext<K>,
) => ShuttleWaterfallMap[K] | Promise<ShuttleWaterfallMap[K]>

/** Registry of well-known services; `ctx.get('llm')` is typed through this map. */
export interface ShuttleServiceMap {}
