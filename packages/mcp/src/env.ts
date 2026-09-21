import type { McpServerConfig } from '@shuttle/config'

const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * Stdio child processes start from a sanitized parent environment (dsh rule):
 * anything smelling like a credential or Shuttle-internal state is dropped,
 * then the config `env` is applied on top.
 */
export function sanitizedEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV.test(key)) continue
    if (key.startsWith('SHUTTLE_')) continue
    out[key] = value
  }
  return out
}

export function validateServerName(name: string): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    throw new Error(`invalid mcp server name "${name}" — expected [A-Za-z0-9_-]{1,32}`)
  }
}

export function configKey(config: McpServerConfig): string {
  return JSON.stringify(config)
}
