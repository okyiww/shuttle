import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EndpointConfig } from '@shuttle/config'
import { isMaskedApiKey, maskConfig, readUserLayer, stringifyYaml, validateConfig, writeUserLayer } from '@shuttle/config'
import { ConfigError } from '@shuttle/config'
import { isLlmError } from '@shuttle/llm'
import { OpenAiCompatibleAdapter } from '@shuttle/llm-openai'
import { HttpError, readJsonBody, sendJson } from './http-utils.js'
import type { ApiState } from './state.js'

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

function publicConfig(state: ApiState): unknown {
  const loaded = state.loaded
  return {
    config: maskConfig(loaded.config),
    layers: loaded.layers.map((layer) => ({ ...layer, config: maskConfig(layer.config) })),
    yaml: stringifyYaml(maskConfig(loaded.config)),
  }
}

export function handleGetConfig(_req: IncomingMessage, res: ServerResponse, state: ApiState): void {
  sendJson(res, 200, publicConfig(state))
}

function parseEndpointBody(raw: unknown): EndpointConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'body must be an endpoint object')
  }
  // Structural validation via the config package; unknown keys are rejected loudly.
  const parsed = validateConfig({ endpoints: { draft: raw as Record<string, unknown> } }, 'request body', new Map())
  const endpoint = parsed.endpoints?.draft
  if (!endpoint) throw new HttpError(400, 'invalid endpoint')
  return endpoint
}

/**
 * PUT /api/config/endpoints/:name — create or wholesale-replace an endpoint
 * in the user layer. `apiKey` tri-state: undefined = keep the stored value
 * (the frontend never echoes the mask back), '' = clear it, other = set.
 */
export async function handlePutEndpoint(req: IncomingMessage, res: ServerResponse, state: ApiState, name: string): Promise<void> {
  if (!NAME_PATTERN.test(name)) throw new HttpError(400, `invalid endpoint name: ${name}`)
  const endpoint = parseEndpointBody(await readJsonBody(req))
  const existing = readUserLayer().endpoints?.[name]?.apiKey
  if (endpoint.apiKey === '') {
    delete endpoint.apiKey // explicit clear
  } else if (endpoint.apiKey === undefined || isMaskedApiKey(endpoint.apiKey)) {
    // Keep the stored value; the frontend never echoes the mask back, and a
    // mask-shaped string sent by any client is treated the same way.
    if (existing !== undefined) endpoint.apiKey = existing
  }
  try {
    writeUserLayer({ endpoints: { [name]: endpoint } }, { replace: [`endpoints.${name}`] })
  } catch (error) {
    if (error instanceof ConfigError) throw new HttpError(400, error.message)
    throw error
  }
  state.reloadConfig()
  sendJson(res, 200, publicConfig(state))
}

/** DELETE /api/config/endpoints/:name — remove from the user layer (project defaults stay read-only). */
export function handleDeleteEndpoint(_req: IncomingMessage, res: ServerResponse, state: ApiState, name: string): void {
  if (!NAME_PATTERN.test(name)) throw new HttpError(400, `invalid endpoint name: ${name}`)
  writeUserLayer({}, { remove: [`endpoints.${name}`] })
  state.reloadConfig()
  sendJson(res, 200, publicConfig(state))
}

/** PUT /api/config/agent — set defaults ({ endpoint?, model? }), persisted to the user layer. */
export async function handlePutAgent(req: IncomingMessage, res: ServerResponse, state: ApiState): Promise<void> {
  const raw = (await readJsonBody(req)) as { endpoint?: unknown; model?: unknown }
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'body must be an object')
  if (raw.endpoint !== undefined && typeof raw.endpoint !== 'string') throw new HttpError(400, 'endpoint must be a string')
  if (raw.model !== undefined && typeof raw.model !== 'string') throw new HttpError(400, 'model must be a string')
  writeUserLayer({ agent: { endpoint: raw.endpoint, model: raw.model } })
  state.reloadConfig()
  sendJson(res, 200, publicConfig(state))
}

function describeTestError(error: unknown): string {
  if (isLlmError(error)) {
    let message = `[${error.code}] ${error.message}`
    if (error.code === 'MISSING_CREDENTIAL' && error.credentialEnv) {
      message += ` — export ${error.credentialEnv}="<your-api-key>"`
    }
    return message
  }
  return error instanceof Error ? error.message : String(error)
}

/** POST /api/endpoints/:name/test — minimal real request against the endpoint. */
export async function handleTestEndpoint(_req: IncomingMessage, res: ServerResponse, state: ApiState, name: string): Promise<void> {
  const endpoint = state.loaded.config.endpoints?.[name]
  if (!endpoint) {
    const available = Object.keys(state.loaded.config.endpoints ?? {}).join(', ') || '(none)'
    sendJson(res, 200, { ok: false, error: `unknown endpoint: ${name} (available: ${available})` })
    return
  }
  const model = endpoint.models?.[0]?.id ?? 'shuttle-test'
  const adapter = new OpenAiCompatibleAdapter({ providers: { [name]: endpoint } })
  const started = Date.now()
  try {
    for await (const chunk of adapter.stream({
      provider: name,
      model,
      maxTokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
      purpose: 'test-connection',
    })) {
      // Drain the stream; the finish chunk confirms the wire works end to end.
      void chunk
    }
    sendJson(res, 200, { ok: true, latencyMs: Date.now() - started })
  } catch (error) {
    // maxTokens=1 下拿到 wire 合法的空响应（EMPTY_RESPONSE）同样证明链路通。
    if (isLlmError(error) && error.code === 'EMPTY_RESPONSE') {
      sendJson(res, 200, { ok: true, latencyMs: Date.now() - started })
      return
    }
    sendJson(res, 200, { ok: false, error: describeTestError(error) })
  }
}
