import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { deepMerge, readUserLayer, userConfigPath } from './loader.js'
import type { ShuttleConfig } from './types.js'

export interface WriteResult {
  path: string
  config: ShuttleConfig
}

export interface WriteOptions {
  home?: string
  /** Dot paths (e.g. `endpoints.mock2`) to delete from the merged user layer before writing. */
  remove?: string[]
  /** Dot paths to drop from the current user layer BEFORE merging — makes PUT semantics a true whole-object replace. */
  replace?: string[]
}

/**
 * Merge `patch` into the user layer and write it back. Creates `~/.shuttle`
 * (0700) and writes the file 0600 — the file may carry endpoint apiKeys and
 * sensitive headers. `replace` drops a path from the current layer BEFORE
 * merging, giving PUT routes true whole-object-replace semantics (omitted
 * keys actually go away).
 */
export function writeUserLayer(patch: ShuttleConfig, options: WriteOptions = {}): WriteResult {
  const path = userConfigPath(options.home)
  let current = readUserLayer(path)
  for (const dotPath of options.replace ?? []) {
    current = deepRemove(current, dotPath)
  }
  const config = deepMerge(current, patch)
  for (const dotPath of options.remove ?? []) deepRemove(config, dotPath)
  const text = stringifyYaml(config)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
  return { path, config }
}

function deepRemove<T>(root: T, dotPath: string): T {
  const keys = dotPath.split('.')
  let node = root as Record<string, unknown> | undefined
  for (let i = 0; i < keys.length - 1; i++) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return root
    node = node[keys[i]!] as Record<string, unknown> | undefined
  }
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    delete node[keys[keys.length - 1]!]
  }
  return root
}

/** Serialize the Phase 0 subset: block maps, block string sequences, flow maps for object arrays. */
export function stringifyYaml(config: ShuttleConfig): string {
  const lines = renderMap(config, 0)
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function renderMap(map: object, indent: number): string[] {
  const pad = '  '.repeat(indent)
  const lines: string[] = []
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      if (value.every((entry) => typeof entry === 'string')) {
        lines.push(`${pad}${key}:`)
        for (const entry of value) lines.push(`${pad}  - ${formatScalar(entry as string)}`)
      } else {
        lines.push(`${pad}${key}:`)
        for (const entry of value) lines.push(`${pad}  - ${formatInline(entry)}`)
      }
      continue
    }
    if (value !== null && typeof value === 'object') {
      const nested = renderMap(value as Record<string, unknown>, indent + 1)
      if (nested.length === 0) continue
      lines.push(`${pad}${key}:`)
      lines.push(...nested)
      continue
    }
    lines.push(`${pad}${key}: ${formatScalar(value)}`)
  }
  return lines
}

function formatInline(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const inner = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${key}: ${formatInline(entry)}`)
      .join(', ')
    return `{ ${inner} }`
  }
  return formatScalar(value)
}

function formatScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  const text = String(value)
  if (
    text === '' ||
    /^\s|\s$/.test(text) ||
    /[:#\[\]{},]/.test(text) ||
    /^(true|false|null|~)$/i.test(text) ||
    /^[+-]?(\d+\.?\d*|\.\d+)$/.test(text) ||
    /^[&*|>@`%!]/.test(text)
  ) {
    return JSON.stringify(text)
  }
  return text
}
