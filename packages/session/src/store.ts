import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Message, ToolCall } from '@shuttle/llm'
import { SESSION_FILE_NAME, SESSION_META_FILE_NAME } from './events.js'
import type { SessionEvent, SessionEventInput } from './events.js'

/** dsh-style cwd encoding: path separators become `-`, wrapped in `--` on both sides. */
export function encodeCwd(cwd: string): string {
  const normalized = cwd.replace(/[/\\:]+/g, '-').replace(/^-+|-+$/g, '')
  return `--${normalized}--`
}

export function sessionsRoot(home: string = homedir()): string {
  return join(home, '.shuttle', 'sessions')
}

export class SessionStore {
  readonly id: string
  readonly dir: string
  readonly file: string

  private constructor(dir: string, id: string) {
    this.id = id
    this.dir = dir
    this.file = join(dir, SESSION_FILE_NAME)
  }

  static create(cwd: string = process.cwd(), id: string = randomUUID()): SessionStore {
    const store = new SessionStore(join(sessionsRoot(), encodeCwd(cwd), id), id)
    mkdirSync(store.dir, { recursive: true })
    // Sidecar metadata lets the API list sessions across cwds without a global index.
    writeFileSync(
      join(store.dir, SESSION_META_FILE_NAME),
      JSON.stringify({ id, cwd, createdAt: new Date().toISOString() }),
    )
    return store
  }

  /** Open an existing session directory without creating it. */
  static open(cwd: string, id: string): SessionStore {
    return new SessionStore(join(sessionsRoot(), encodeCwd(cwd), id), id)
  }

  /** Open a session by its absolute directory (used when listing found it elsewhere). */
  static openDir(dir: string, id: string): SessionStore {
    return new SessionStore(dir, id)
  }

  /** Synchronous append + close: the event is on disk before this returns. */
  append(event: SessionEventInput): void {
    const line = JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })
    const fd = openSync(this.file, 'a')
    try {
      writeSync(fd, `${line}\n`)
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Committed prefix of the log. Lines are JSON.parsed one by one; the first
   * corrupt line (and everything after it) is truncated from the file — a
   * crash mid-append never yields a torn tail.
   */
  readAll(): SessionEvent[] {
    if (!existsSync(this.file)) return []
    const text = readFileSync(this.file, 'utf8')
    const events: SessionEvent[] = []
    let offset = 0
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const start = offset
      offset += line.length + 1
      if (line.trim() === '') {
        if (i === lines.length - 1) break // trailing newline of a healthy file
        truncateAt(this.file, start)
        break
      }
      let event: SessionEvent
      try {
        event = JSON.parse(line) as SessionEvent
        if (!event || typeof event.type !== 'string') throw new Error('not a session event')
      } catch {
        truncateAt(this.file, start)
        break
      }
      events.push(event)
    }
    return events
  }

  /**
   * Model-visible history derived from the committed prefix — the log is the
   * only storage. A consecutive run of tool/call + tool/result events folds
   * into one assistant message carrying `toolCalls` plus one `role: 'tool'`
   * message per paired result; unpaired calls are dropped.
   */
  deriveMessages(): Message[] {
    const events = this.readAll()
    const messages: Message[] = []
    let i = 0
    while (i < events.length) {
      const event = events[i]!
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        messages.push(event.message)
        i++
        continue
      }
      if (event.type !== 'tool/call') {
        i++
        continue
      }
      const calls = new Map<string, ToolCall>()
      const results = new Map<string, string>()
      let j = i
      for (;;) {
        const entry = events[j]
        if (!entry || (entry.type !== 'tool/call' && entry.type !== 'tool/result')) break
        if (entry.type === 'tool/call') {
          calls.set(entry.toolCallId, { id: entry.toolCallId, name: entry.name, arguments: entry.arguments })
        } else {
          results.set(entry.toolCallId, entry.content)
        }
        j++
      }
      const toolCalls: ToolCall[] = []
      const toolMessages: Message[] = []
      for (const [toolCallId, call] of calls) {
        const content = results.get(toolCallId)
        if (content === undefined) continue
        toolCalls.push(call)
        toolMessages.push({ role: 'tool', toolCallId, content })
      }
      if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: '', toolCalls })
        messages.push(...toolMessages)
      }
      i = j
    }
    return messages
  }
}

function truncateAt(file: string, size: number): void {
  const fd = openSync(file, 'r+')
  try {
    ftruncateSync(fd, size)
  } finally {
    closeSync(fd)
  }
}
