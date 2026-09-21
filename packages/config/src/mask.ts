import type { EndpointConfig, ShuttleConfig } from './types.js'

/**
 * Mask a secret for display: first 3 + `****` + last 4. Keys of 7 chars or
 * fewer are masked entirely (a 7-char key would otherwise be fully revealed
 * by first-3 + last-4).
 */
export function maskSecret(value: string): string {
  if (value.length <= 7) return '****'
  return `${value.slice(0, 3)}****${value.slice(-4)}`
}

/** Copy of an endpoint with `apiKey` masked — safe for every read path. */
export function maskEndpointConfig(endpoint: EndpointConfig): EndpointConfig {
  if (endpoint.apiKey === undefined) return { ...endpoint }
  return { ...endpoint, apiKey: endpoint.apiKey === '' ? '' : maskSecret(endpoint.apiKey) }
}

/**
 * Deep-ish copy of the merged config with every endpoint apiKey masked.
 * The result is what GET /api/config, the config-page YAML and
 * `shuttle config --dump` render; plaintext stays server-side only.
 */
export function maskConfig(config: ShuttleConfig): ShuttleConfig {
  const out: ShuttleConfig = { ...config }
  if (config.endpoints) {
    out.endpoints = Object.fromEntries(
      Object.entries(config.endpoints).map(([name, endpoint]) => [name, maskEndpointConfig(endpoint)]),
    )
  }
  return out
}

export function isMaskedApiKey(value: string | undefined): boolean {
  return value !== undefined && (value === '' || value.endsWith('****') || value === '****')
}
