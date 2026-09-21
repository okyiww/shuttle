import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ConfigError } from './errors.js'
import type { ConfigLayer, LoadedConfig, ShuttleConfig } from './types.js'
import { validateConfig } from './validate.js'
import { parseYaml } from './yaml.js'

export const PROJECT_CONFIG_NAME = 'shuttle.config.yml'

export function userConfigPath(home: string = homedir()): string {
  return join(home, '.shuttle', 'config.yml')
}

export function resolveConfigPaths(cwd: string): { projectPath: string; userPath: string } {
  return {
    projectPath: resolve(cwd, PROJECT_CONFIG_NAME),
    userPath: userConfigPath(),
  }
}

/**
 * Layered load: project `shuttle.config.yml` (read-only base) then user
 * `~/.shuttle/config.yml`, deep-merged with the user layer winning. Missing
 * files are fine; a file that exists but fails parsing/validation is loud.
 */
export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  const { projectPath, userPath } = resolveConfigPaths(cwd)
  const layers: ConfigLayer[] = []
  for (const [path, writable] of [
    [projectPath, false],
    [userPath, true],
  ] as const) {
    if (!existsSync(path)) continue
    layers.push({ path, config: readLayer(path), writable })
  }
  const config = layers.reduce<ShuttleConfig>((acc, layer) => deepMerge(acc, layer.config), {})
  return { config, layers }
}

function readLayer(path: string): ShuttleConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ConfigError('CONFIG_INVALID', `cannot read config file: ${(error as Error).message}`, { path, cause: error })
  }
  const { value, lines } = parseYaml(text, path)
  return validateConfig(value, path, lines)
}

/** Current content of the user layer file, or `{}` when it does not exist yet. */
export function readUserLayer(path: string = userConfigPath()): ShuttleConfig {
  return existsSync(path) ? readLayer(path) : {}
}

/** Deep merge: plain objects merge recursively, everything else (incl. arrays) is overridden. */
export function deepMerge<T>(base: T, override: T): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new ConfigError('CONFIG_INVALID', `unsafe key during merge: ${key}`)
    }
    out[key] = key in out ? deepMerge(out[key], value) : value
  }
  return out as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
