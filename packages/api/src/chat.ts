import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EndpointConfig, ShuttleConfig } from '@shuttle/config'
import { readUserLayer, writeUserLayer } from '@shuttle/config'
import { isLlmError } from '@shuttle/llm'
import { SessionStore } from '@shuttle/session'
import type { AskDecision } from '@shuttle/tools'
import { createApprovalSink, resolveApproval } from './approvals.js'
import { ensureContextInjections } from './context-injections.js'
import { HttpError, readJsonBody } from './http-utils.js'
import { findSessionDir } from './session-index.js'
import { startSse } from './sse.js'
import { BASE_SYSTEM_PROMPT } from './state.js'
import type { ApiState } from './state.js'
import { runTurnLoop } from './turn-loop.js'

interface ChatBody {
  sessionId?: string
  message?: string
  /** 图片附件：data URL 数组（`data:<mime>;base64,…`）。 */
  images?: unknown
  endpoint?: string
  model?: string
}

const MAX_IMAGES = 4
const MAX_IMAGE_CHARS = 2_000_000 // data URL 字符串长度（约 1.5MB 二进制）

function parseImages(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new HttpError(400, 'images must be an array of data URLs')
  if (raw.length === 0) return undefined
  if (raw.length > MAX_IMAGES) throw new HttpError(400, `at most ${MAX_IMAGES} images per message`)
  for (const item of raw) {
    if (typeof item !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/.test(item)) {
      throw new HttpError(400, 'each image must be a data:image/...;base64 URL')
    }
    if (item.length > MAX_IMAGE_CHARS) throw new HttpError(400, 'image exceeds size limit')
  }
  return raw as string[]
}

export function resolveChatTarget(
  config: ShuttleConfig,
  body: Pick<ChatBody, 'endpoint' | 'model'>,
): { endpointName: string; endpoint: EndpointConfig; model: string } {
  const endpoints = config.endpoints ?? {}
  const names = Object.keys(endpoints)
  const endpointName = body.endpoint ?? config.agent?.endpoint ?? (names.length === 1 ? names[0] : undefined)
  if (!endpointName) {
    throw new HttpError(
      400,
      names.length === 0
        ? 'no endpoints configured — add one in the Endpoints tab first'
        : `no endpoint selected — pass one of: ${names.join(', ')}`,
    )
  }
  const endpoint = endpoints[endpointName]
  if (!endpoint) {
    throw new HttpError(400, `unknown endpoint: ${endpointName} (available: ${names.join(', ')})`)
  }
  const model = body.model ?? config.agent?.model ?? endpoint.models?.[0]?.id
  if (!model) {
    throw new HttpError(400, `no model configured for endpoint "${endpointName}" — pass model explicitly`)
  }
  return { endpointName, endpoint, model }
}

function describeStreamError(error: unknown): { message: string } {
  if (isLlmError(error)) {
    let message = error.message
    if (error.code === 'MISSING_CREDENTIAL' && error.credentialEnv) {
      message += ` — export ${error.credentialEnv}="<your-api-key>" and retry`
    }
    return { message: `[${error.code}] ${message}` }
  }
  if (error instanceof Error) return { message: error.message }
  return { message: String(error) }
}

function openSession(cwd: string, sessionId: string | undefined) {
  if (!sessionId) return SessionStore.create(cwd)
  const found = findSessionDir(sessionId)
  if (!found) throw new HttpError(404, `session not found: ${sessionId}`)
  return SessionStore.openDir(found.dir, sessionId)
}

function parseChatBody(raw: unknown): ChatBody & { message: string; images?: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'body must be a JSON object')
  }
  const body = raw as ChatBody
  const images = parseImages(body.images)
  if (typeof body.message !== 'string' || (body.message.trim() === '' && !images?.length)) {
    throw new HttpError(400, 'message must be a non-empty string (or attach an image)')
  }
  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
    throw new HttpError(400, 'sessionId must be a string')
  }
  return { ...body, message: body.message, images }
}

/** `allow-remember` persistence: append {prefix: <tool full name>, action: allow} to user-layer policies. */
export function rememberToolAllowed(state: ApiState, tool: string): void {
  const existing = readUserLayer().tools?.guard?.policies ?? []
  writeUserLayer({ tools: { guard: { policies: [...existing, { prefix: tool, action: 'allow' }] } } })
  state.reloadConfig()
}

const truncate = (text: string, max = 2048): string => (text.length > max ? `${text.slice(0, max)}…` : text)

/**
 * POST /api/chat — one full turn (step loop with tool execution). SSE frames:
 * `chunk` per StreamChunk, `tool` {kind:call|result}, `approval` when the
 * guard asks, then `done` ({ sessionId, usage, finishReason }); failures
 * become an `error` event and the stream closes (never a hung connection).
 */
export async function handleChat(req: IncomingMessage, res: ServerResponse, state: ApiState, cwd: string): Promise<void> {
  const raw = parseChatBody(await readJsonBody(req))
  const session = openSession(cwd, raw.sessionId)
  const target = resolveChatTarget(state.loaded.config, raw)

  const sse = startSse(res)
  const turn = session.readAll().filter((event) => event.type === 'turn/start').length + 1
  session.append({ type: 'turn/start', turn })
  session.append({ type: 'user/message', message: { role: 'user', content: raw.message, ...(raw.images ? { images: raw.images } : {}) } })
  ensureContextInjections(session, state, cwd)

  const onRemember = (tool: string): void => rememberToolAllowed(state, tool)
  const ask = createApprovalSink(sse, { onRemember })
  try {
    const additions = state.mcp.getSystemPromptAdditions()
    const systemPrompt = [BASE_SYSTEM_PROMPT, additions].filter(Boolean).join('\n\n')
    const outcome = await runTurnLoop(
      {
        llm: state.llm,
        tools: state.tools,
        session,
        provider: target.endpointName,
        model: target.model,
        systemPrompt,
        waitForTools: () => state.mcp.settle(10_000),
      },
      {
        onChunk: (chunk) => sse.write('chunk', chunk),
        onToolCall: (call) => {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
          } catch {
            // the loop will fail the call with a readable error; show raw below
          }
          sse.write('tool', { kind: 'call', id: call.id, name: call.name, args })
        },
        onToolResult: (call, result) =>
          sse.write('tool', { kind: 'result', id: call.id, ok: result.ok, content: truncate(result.content) }),
        onAsk: (call) => {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
          } catch {
            // leave empty; the loop fails the call with a readable error
          }
          return ask(call.name, args)
        },
      },
    )
    session.append({ type: 'turn/end' })
    sse.write('done', { sessionId: session.id, usage: outcome.usage, finishReason: outcome.finishReason })
  } catch (error) {
    try {
      session.append({ type: 'turn/end', error: error instanceof Error ? error.message : String(error) })
    } catch {
      // best-effort audit; never mask the original error
    }
    sse.write('error', describeStreamError(error))
  } finally {
    sse.end()
  }
}
