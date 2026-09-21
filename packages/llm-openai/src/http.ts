import type { EndpointConfig } from '@shuttle/config'
import { LlmError } from '@shuttle/llm'

export const DEFAULT_TIMEOUT_MS = 120_000

const CONTEXT_WINDOW_PATTERN = /context[ _]window|context length|maximum context|too many tokens|prompt is too long|input is too long|reduce the length/i

/**
 * Resolve the credential at request time (never at startup): config `apiKey`
 * wins; when it is absent or empty, fall back to the environment variable
 * named by `apiKeyEnv`. The error spells out exactly which source is missing.
 */
export function resolveApiKey(endpoint: EndpointConfig, provider: string): string {
  const configured = endpoint.apiKey
  if (configured !== undefined && configured.trim() !== '') return configured
  const envName = endpoint.apiKeyEnv
  const fromEnv = envName ? process.env[envName] : undefined
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  const envNote = envName ? `environment variable ${envName} is not set` : 'no apiKeyEnv configured'
  const detail =
    configured !== undefined
      ? `configured apiKey is empty and ${envNote}`
      : `no apiKey configured and ${envNote}`
  throw new LlmError({
    code: 'MISSING_CREDENTIAL',
    provider,
    message: `missing credential: ${detail}`,
    credentialEnv: envName,
  })
}

/** Caller signal combined with the endpoint timeout; the timeout applies per request attempt. */
export function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  if (signal.aborted) return signal
  return AbortSignal.any([signal, timeout])
}

export async function assertOk(response: Response, provider: string): Promise<void> {
  if (response.ok) return
  const body = await readErrorBody(response)
  const detail = body ? `: ${body}` : ''
  const status = response.status
  if (CONTEXT_WINDOW_PATTERN.test(body)) {
    throw new LlmError({
      code: 'CONTEXT_WINDOW_EXCEEDED',
      provider,
      message: `context window exceeded (HTTP ${status})${detail}`,
    })
  }
  if (status === 401) {
    throw new LlmError({ code: 'AUTH', provider, message: `authentication failed (HTTP 401)${detail}` })
  }
  if (status === 429) {
    throw new LlmError({ code: 'RATE_LIMIT', provider, retryable: true, message: `rate limited (HTTP 429)${detail}` })
  }
  throw new LlmError({
    code: 'UNEXPECTED_STATUS',
    provider,
    retryable: status >= 500,
    message: `unexpected status ${status}${detail}`,
  })
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400)
  } catch {
    return ''
  }
}

export function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}/${path}`
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      cleanup()
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer.unref()
  })
}
