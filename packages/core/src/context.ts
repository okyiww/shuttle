import { CoreError } from './errors.js'
import type {
  EventArgs,
  EventListener,
  ShuttleEventMap,
  ShuttleServiceMap,
  ShuttleWaterfallMap,
  WaterfallListener,
} from './events.js'

export type Disposer = () => void | Promise<void>

export type ServiceKey = string | symbol

export interface PluginDef<Config = unknown> {
  name: string
  apply(ctx: Context, config: Config): void | Disposer
}

type AnyListener = (...args: any[]) => unknown

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export interface ContextOptions {
  /** Listener errors from `emit` are reported here instead of crashing. */
  onError?: (error: unknown) => void
}

export class Context {
  private services = new Map<ServiceKey, unknown>()
  private listeners = new Map<ServiceKey, Set<AnyListener>>()
  private effects: Disposer[] = []
  private disposed = false
  private readonly report: (error: unknown) => void

  constructor(options: ContextOptions = {}) {
    this.report = options.onError ?? ((error) => console.error(error))
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  register(key: ServiceKey, service: unknown): Disposer {
    this.assertAlive()
    if (this.services.has(key)) {
      throw new CoreError('DUPLICATE_SERVICE', `service already registered: ${String(key)}`)
    }
    this.services.set(key, service)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      // Only remove if still the same instance; a re-registered replacement
      // must not be yanked by the previous owner's disposer.
      if (this.services.get(key) === service) this.services.delete(key)
    }
  }

  get<K extends keyof ShuttleServiceMap>(key: K): ShuttleServiceMap[K]
  get(key: ServiceKey): unknown
  get(key: ServiceKey): unknown {
    if (!this.services.has(key)) {
      throw new CoreError('MISSING_SERVICE', `service not registered: ${String(key)}`)
    }
    return this.services.get(key)
  }

  on<K extends keyof ShuttleEventMap>(name: K, listener: EventListener<K>): Disposer
  on<K extends keyof ShuttleWaterfallMap>(name: K, listener: WaterfallListener<K>): Disposer
  on(name: ServiceKey, listener: AnyListener): Disposer {
    this.assertAlive()
    let set = this.listeners.get(name)
    if (!set) {
      set = new Set()
      this.listeners.set(name, set)
    }
    set.add(listener)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      set.delete(listener)
    }
  }

  /** Fire-and-forget: sync dispatch, async listener results and errors are dropped (reported). */
  emit<K extends keyof ShuttleEventMap>(name: K, ...args: EventArgs<K>): void {
    const set = this.listeners.get(name)
    if (!set) return
    for (const listener of [...set]) {
      try {
        void listener(...(args as unknown[]))
      } catch (error) {
        this.report(error)
      }
    }
  }

  /** Sequential: await each listener in registration order. */
  async serial<K extends keyof ShuttleEventMap>(name: K, ...args: EventArgs<K>): Promise<void> {
    const set = this.listeners.get(name)
    if (!set) return
    for (const listener of [...set]) {
      await listener(...(args as unknown[]))
    }
  }

  /**
   * Waterfall: each listener gets `(value, next)`. Calling `next(v)` continues
   * with the next listener and its awaited result must be returned; not calling
   * `next` short-circuits and the listener's own return value is final.
   */
  async waterfall<K extends keyof ShuttleWaterfallMap>(
    name: K,
    value: ShuttleWaterfallMap[K],
  ): Promise<ShuttleWaterfallMap[K]> {
    const listeners = [...(this.listeners.get(name) ?? [])] as WaterfallListener<K>[]
    let index = 0
    const next = async (current: ShuttleWaterfallMap[K]): Promise<ShuttleWaterfallMap[K]> => {
      if (index >= listeners.length) return current
      const listener = listeners[index++]!
      return listener(current, next)
    }
    return next(value)
  }

  /**
   * Run `fn` now and push the disposer it returns onto the effect stack. The
   * returned disposer un-registers and runs it immediately — synchronously
   * when `fn` returned its disposer synchronously (teardown must not race a
   * re-registration on the next line).
   */
  effect(fn: () => void | Disposer | Promise<void | Disposer>): Disposer {
    this.assertAlive()
    const pending = fn()
    const run = (resolved: void | Disposer): void | Promise<void> =>
      typeof resolved === 'function' ? resolved() : undefined
    const dispose: Disposer = isPromiseLike(pending)
      ? () => Promise.resolve(pending).then(run)
      : () => run(pending)
    this.effects.push(dispose)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      const at = this.effects.indexOf(dispose)
      if (at >= 0) this.effects.splice(at, 1)
      void dispose()
    }
  }

  /** Run a plugin definition and host its disposer on the effect stack. */
  plugin<Config>(def: PluginDef<Config>, config: Config): Disposer {
    return this.effect(() => def.apply(this, config))
  }

  /** Unwind all effects in reverse registration order. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const stack = this.effects
    this.effects = []
    for (let i = stack.length - 1; i >= 0; i--) {
      try {
        await stack[i]!()
      } catch (error) {
        this.report(error)
      }
    }
    this.services.clear()
    this.listeners.clear()
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new CoreError('ALREADY_DISPOSED', 'context is already disposed')
    }
  }
}
