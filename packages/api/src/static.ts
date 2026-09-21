import { existsSync, statSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** Serve the built SPA from `dist` (no fallback — Shuttle's SPA has no routes). */
export function createStaticHandler(distDir: string): ((req: IncomingMessage, res: ServerResponse, pathname: string) => boolean) | undefined {
  if (!distDir || !existsSync(distDir)) return undefined
  const root = resolve(distDir)
  return (req, res, pathname) => {
    let filePath = normalize(join(root, pathname === '/' ? 'index.html' : pathname))
    if (filePath !== root && !filePath.startsWith(root + sep)) return false // traversal guard
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, 'index.html')
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false
    const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type })
    createReadStream(filePath).pipe(res)
    return true
  }
}
