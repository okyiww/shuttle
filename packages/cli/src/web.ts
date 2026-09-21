import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { createApiServer } from '@shuttle/api'
import { CliError } from './errors.js'

export interface WebArgs {
  port: number
  noOpen: boolean
}

export function parseWebArgs(argv: string[]): WebArgs {
  let port = 4080
  let noOpen = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--port') {
      const value = argv[++i]
      if (value === undefined || !/^\d+$/.test(value)) throw new CliError('--port requires a number')
      port = Number(value)
    } else if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length)
      if (!/^\d+$/.test(value)) throw new CliError('--port requires a number')
      port = Number(value)
    } else if (arg === '--no-open') {
      noOpen = true
    } else {
      throw new CliError(`unknown flag: ${arg}`)
    }
  }
  if (port < 1 || port > 65535) throw new CliError(`--port out of range: ${port}`)
  return { port, noOpen }
}

/**
 * Resolve the built SPA: <repo>/apps/web/dist. Two candidates because dev runs
 * from packages/cli/src while the built CLI runs from packages/cli/lib.
 */
function defaultStaticDir(): string {
  const candidates = [
    fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
    fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
  ]
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]!
}

/**
 * `shuttle web` — start the BFF (serving apps/web/dist when built) and keep
 * the process alive. Port conflicts fail loud before any browser opens.
 */
export async function runWeb(argv: string[]): Promise<void> {
  const args = parseWebArgs(argv)
  const staticDir = process.env.SHUTTLE_WEB_DIST ?? defaultStaticDir()
  let server
  try {
    server = await createApiServer({ cwd: process.cwd(), port: args.port, staticDir })
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }
  process.stderr.write(`shuttle web: ${server.url}\n`)
  if (!args.noOpen) {
    execFile('open', [server.url], () => {
      // Browser open is best-effort; the server keeps running regardless.
    })
  }
  await new Promise<void>((resolveClose) => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      void server.close().then(() => resolveClose())
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
}
