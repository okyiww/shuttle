import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { handleChat } from './chat.js'
import { applyCors, handlePreflight, HttpError, pathSegments, sendError } from './http-utils.js'
import {
  handleDeleteEndpoint,
  handleGetConfig,
  handlePutAgent,
  handlePutEndpoint,
  handleTestEndpoint,
} from './routes-config.js'
import {
  handleAuthorizeMcp,
  handleDeleteMcpServer,
  handleGetGuard,
  handleListMcp,
  handleOAuthCallback,
  handlePutGuard,
  handlePutMcpServer,
  handleReconnectMcp,
  handleResolveApproval,
} from './routes-mcp.js'
import { handleListSessions, handleSessionEvents } from './routes-sessions.js'
import { createStaticHandler } from './static.js'
import { createState } from './state.js'
import type { ApiState } from './state.js'

export interface ApiServerOptions {
  cwd?: string
  port?: number
  host?: string
  /** Built SPA directory; served when it exists (same-origin production mode). */
  staticDir?: string
  /** Dev only: allow localhost origins (vite runs on its own port). */
  cors?: boolean
}

export interface ApiServer {
  url: string
  port: number
  close(): Promise<void>
}

export async function createApiServer(options: ApiServerOptions = {}): Promise<ApiServer> {
  const cwd = options.cwd ?? process.cwd()
  const host = options.host ?? '127.0.0.1'
  const state = createState(cwd)
  const staticHandler = createStaticHandler(options.staticDir ?? '')

  const server: Server = createServer((req, res) => {
    dispatch(req, res, state, cwd, options.cors ?? false, staticHandler).catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof HttpError) sendError(res, error.status, error.message)
      else sendError(res, 500, error instanceof Error ? error.message : String(error))
    })
  })

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        const reason = error.code === 'EADDRINUSE' ? `port ${options.port} is already in use` : error.message
        rejectPromise(new Error(`cannot start api on ${host}:${options.port ?? 0} — ${reason}`))
      })
      server.listen(options.port ?? 0, host, () => resolvePromise())
    })
  } catch (error) {
    await state.dispose()
    throw error
  }

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0)
  state.mcp.setRedirectBase(`http://${host}:${port}`)

  return {
    url: `http://${host}:${port}`,
    port,
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await state.dispose()
    },
  }
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  state: ApiState,
  cwd: string,
  cors: boolean,
  staticHandler: ReturnType<typeof createStaticHandler>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const segs = pathSegments(url.pathname)
  applyCors(req, res, cors)
  if (req.method === 'OPTIONS') {
    handlePreflight(res)
    return
  }

  if (segs[0] === 'api') {
    if (segs.length === 2 && segs[1] === 'config' && req.method === 'GET') {
      handleGetConfig(req, res, state)
      return
    }
    if (segs.length === 4 && segs[1] === 'config' && segs[2] === 'endpoints' && req.method === 'PUT') {
      await handlePutEndpoint(req, res, state, segs[3]!)
      return
    }
    if (segs.length === 4 && segs[1] === 'config' && segs[2] === 'endpoints' && req.method === 'DELETE') {
      handleDeleteEndpoint(req, res, state, segs[3]!)
      return
    }
    if (segs.length === 3 && segs[1] === 'config' && segs[2] === 'agent' && req.method === 'PUT') {
      await handlePutAgent(req, res, state)
      return
    }
    if (segs.length === 4 && segs[1] === 'endpoints' && segs[3] === 'test' && req.method === 'POST') {
      await handleTestEndpoint(req, res, state, segs[2]!)
      return
    }
    if (segs.length === 2 && segs[1] === 'sessions' && req.method === 'GET') {
      handleListSessions(req, res)
      return
    }
    if (segs.length === 4 && segs[1] === 'sessions' && segs[3] === 'events' && req.method === 'GET') {
      handleSessionEvents(req, res, segs[2]!)
      return
    }
    if (segs.length === 2 && segs[1] === 'chat' && req.method === 'POST') {
      await handleChat(req, res, state, cwd)
      return
    }
    if (segs.length === 2 && segs[1] === 'mcp' && req.method === 'GET') {
      handleListMcp(req, res, state)
      return
    }
    if (segs.length === 5 && segs[1] === 'config' && segs[2] === 'mcp' && segs[3] === 'servers' && req.method === 'PUT') {
      await handlePutMcpServer(req, res, state, segs[4]!)
      return
    }
    if (segs.length === 5 && segs[1] === 'config' && segs[2] === 'mcp' && segs[3] === 'servers' && req.method === 'DELETE') {
      handleDeleteMcpServer(req, res, state, segs[4]!)
      return
    }
    if (segs.length === 5 && segs[1] === 'mcp' && segs[2] === 'servers' && segs[4] === 'reconnect' && req.method === 'POST') {
      handleReconnectMcp(req, res, state, segs[3]!)
      return
    }
    if (segs.length === 5 && segs[1] === 'mcp' && segs[2] === 'servers' && segs[4] === 'authorize' && req.method === 'POST') {
      await handleAuthorizeMcp(req, res, state, segs[3]!)
      return
    }
    if (segs.length === 3 && segs[1] === 'oauth' && segs[2] === 'callback' && req.method === 'GET') {
      await handleOAuthCallback(req, res, state, url.searchParams)
      return
    }
    if (segs.length === 3 && segs[1] === 'config' && segs[2] === 'tools-guard' && req.method === 'GET') {
      handleGetGuard(req, res, state)
      return
    }
    if (segs.length === 3 && segs[1] === 'config' && segs[2] === 'tools-guard' && req.method === 'PUT') {
      await handlePutGuard(req, res, state)
      return
    }
    if (segs.length === 3 && segs[1] === 'approvals' && req.method === 'POST') {
      await handleResolveApproval(req, res, state, segs[2]!)
      return
    }
    sendError(res, 404, `unknown api route: ${req.method} ${url.pathname}`)
    return
  }

  if (staticHandler && (req.method === 'GET' || req.method === 'HEAD') && staticHandler(req, res, url.pathname)) {
    return
  }
  sendError(res, 404, `not found: ${url.pathname}`)
}
