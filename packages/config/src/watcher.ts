import { mkdirSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Disposer } from '@shuttle/core'
import { loadConfig, resolveConfigPaths } from './loader.js'
import type { LoadedConfig } from './types.js'

export type WatchEvent =
  | ({ type: 'update' } & LoadedConfig)
  | { type: 'error'; error: unknown }

export interface WatchOptions {
  debounceMs?: number
}

/**
 * Hot reload: watch both config files (file watch, falling back to the parent
 * directory when the file does not exist yet) and re-run `loadConfig` after a
 * debounce. Parse/validation failures arrive as `{ type: 'error' }` events.
 */
export function watchConfig(
  cwd: string,
  onEvent: (event: WatchEvent) => void,
  options: WatchOptions = {},
): Disposer {
  const debounceMs = options.debounceMs ?? 100
  const { projectPath, userPath } = resolveConfigPaths(cwd)
  let closed = false
  let timer: NodeJS.Timeout | undefined
  const reload = (): void => {
    if (closed) return
    try {
      onEvent({ type: 'update', ...loadConfig(cwd) })
    } catch (error) {
      onEvent({ type: 'error', error })
    }
  }
  const schedule = (): void => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(reload, debounceMs)
    timer.unref()
  }
  const watchers = [watchPath(projectPath, schedule), watchPath(userPath, schedule)]
  return () => {
    closed = true
    clearTimeout(timer)
    for (const watcher of watchers) watcher.close()
  }
}

function watchPath(path: string, onChange: () => void): FSWatcher {
  try {
    return watch(path, onChange)
  } catch {
    // File missing: make sure the parent exists (it is Shuttle's own state
    // dir, and writeUserLayer creates it on first write anyway), then watch
    // the file; fall back to watching the directory filtered by its name.
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      return watch(path, onChange)
    } catch {
      const name = basename(path)
      return watch(dirname(path), (_event, filename) => {
        if (filename === name) onChange()
      })
    }
  }
}
