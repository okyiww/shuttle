import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * dsh semantics: walk upward from cwd to the nearest directory containing a
 * `.git` marker; fall back to cwd itself when no ancestor qualifies.
 */
export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** Per-project Shuttle state directory (skills, notes, ...). */
export function shuttleDir(projectRoot: string): string {
  return join(projectRoot, '.shuttle')
}
