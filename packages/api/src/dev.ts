import { createApiServer } from './server.js'

// pnpm -r runs package scripts in the package dir; SHUTTLE_CWD (set by the
// root `pnpm dev`) points the dev server at the project you are working on.
const cwd = process.env.SHUTTLE_CWD || process.cwd()
const port = Number(process.env.SHUTTLE_PORT ?? 4080)
const { url } = await createApiServer({ cwd, port, cors: true })
console.error(`[shuttle api dev] ${url} (cors enabled for the vite dev server)`)
