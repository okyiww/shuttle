import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError, sendJson } from './http-utils.js'
import { clearAllSessions, isValidSessionId, listSessions, readSessionEvents } from './session-index.js'

export function handleListSessions(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, listSessions())
}

export function handleClearSessions(_req: IncomingMessage, res: ServerResponse): void {
  const deleted = clearAllSessions()
  sendJson(res, 200, { ok: true, deleted })
}

export function handleSessionEvents(_req: IncomingMessage, res: ServerResponse, id: string): void {
  if (!isValidSessionId(id)) {
    sendError(res, 400, `invalid session id: ${id}`)
    return
  }
  const detail = readSessionEvents(id)
  if (!detail) {
    sendError(res, 404, `session not found: ${id}`)
    return
  }
  sendJson(res, 200, detail)
}
