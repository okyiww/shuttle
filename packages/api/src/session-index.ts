import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsRoot, SESSION_FILE_NAME, SESSION_META_FILE_NAME } from '@shuttle/session'
import type { SessionEvent } from '@shuttle/session'

export interface SessionSummary {
  id: string
  cwd: string
  title: string
  updatedAt: string
}

export interface SessionDetail {
  id: string
  cwd: string
  events: SessionEvent[]
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id)
}

interface SessionDir {
  id: string
  dir: string
  logFile: string
}

function scanSessionDirs(): SessionDir[] {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const out: SessionDir[] = []
  for (const cwdEntry of readdirSync(root, { withFileTypes: true })) {
    if (!cwdEntry.isDirectory()) continue
    const cwdDir = join(root, cwdEntry.name)
    for (const idEntry of readdirSync(cwdDir, { withFileTypes: true })) {
      if (!idEntry.isDirectory()) continue
      const dir = join(cwdDir, idEntry.name)
      const logFile = join(dir, SESSION_FILE_NAME)
      if (existsSync(logFile)) out.push({ id: idEntry.name, dir, logFile })
    }
  }
  return out
}

function readSidecar(dir: string): { cwd?: string; createdAt?: string } {
  try {
    return JSON.parse(readFileSync(join(dir, SESSION_META_FILE_NAME), 'utf8')) as { cwd?: string; createdAt?: string }
  } catch {
    return {}
  }
}

function readTitle(logFile: string): string {
  try {
    const text = readFileSync(logFile, 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line) as SessionEvent
        if (event.type === 'user/message' && typeof event.message.content === 'string') {
          return event.message.content.slice(0, 40)
        }
      } catch {
        break // corrupt tail: committed prefix already scanned
      }
    }
  } catch {
    // unreadable log — leave title empty
  }
  return ''
}

export function listSessions(): SessionSummary[] {
  return scanSessionDirs()
    .map((entry) => {
      const sidecar = readSidecar(entry.dir)
      return {
        id: entry.id,
        cwd: sidecar.cwd ?? '(unknown cwd)',
        title: readTitle(entry.logFile) || '(empty session)',
        updatedAt: statSync(entry.logFile).mtime.toISOString(),
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Delete every session directory (all cwds). Returns how many were removed. */
export function clearAllSessions(): number {
  const dirs = scanSessionDirs()
  for (const entry of dirs) rmSync(entry.dir, { recursive: true, force: true })
  return dirs.length
}

/** Locate a session dir by id across all cwds (sessions are resumable from any project). */
export function findSessionDir(id: string): SessionDir | undefined {
  if (!isValidSessionId(id)) return undefined
  return scanSessionDirs().find((entry) => entry.id === id)
}

export function readSessionEvents(id: string): SessionDetail | undefined {
  const found = findSessionDir(id)
  if (!found) return undefined
  const sidecar = readSidecar(found.dir)
  const events: SessionEvent[] = []
  const text = readFileSync(found.logFile, 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line) as SessionEvent)
    } catch {
      break
    }
  }
  return { id, cwd: sidecar.cwd ?? '(unknown cwd)', events }
}
