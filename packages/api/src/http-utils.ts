import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BODY_BYTES = 256 * 1024

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let text = ''
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    text += (chunk as Buffer).toString('utf8')
  }
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpError(400, 'request body must be valid JSON')
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** localhost-only CORS for dev (vite on another port); production is same-origin. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

export function applyCors(req: IncomingMessage, res: ServerResponse, enabled: boolean): boolean {
  const origin = req.headers.origin
  if (!enabled || !origin || !LOCAL_ORIGIN.test(origin)) return false
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('vary', 'origin')
  return true
}

export function handlePreflight(res: ServerResponse): void {
  res.writeHead(204, {
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  })
  res.end()
}

/** Split a request path into segments; `/api/sessions/abc/events` -> ['api','sessions','abc','events']. */
export function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map(decodeURIComponent)
}
