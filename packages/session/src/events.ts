import type { Message } from '@shuttle/llm'

/** Current on-disk format; the filename carries it (`session.v<N>.jsonl`). */
export const SESSION_FORMAT_VERSION = 1

export const SESSION_FILE_NAME = `session.v${SESSION_FORMAT_VERSION}.jsonl`

/** Sidecar written next to the log: { id, cwd, createdAt } for cross-cwd listing. */
export const SESSION_META_FILE_NAME = 'session.json'

export interface SessionEventBase {
  /** ISO timestamp, set by `SessionStore.append`. */
  at: string
}

export type SessionEvent =
  | (SessionEventBase & { type: 'turn/start'; turn: number })
  | (SessionEventBase & { type: 'turn/end'; error?: string })
  | (SessionEventBase & { type: 'step/start' })
  | (SessionEventBase & { type: 'step/end' })
  | (SessionEventBase & { type: 'user/message'; message: Message })
  | (SessionEventBase & { type: 'assistant/message'; message: Message })
  | (SessionEventBase & { type: 'tool/call'; toolCallId: string; name: string; arguments: string })
  | (SessionEventBase & { type: 'tool/result'; toolCallId: string; content: string })
  | (SessionEventBase & {
      type: 'context/injection'
      tag: 'agent-instructions' | 'skills-catalog'
      digest: string
      content: string
    })

export type SessionEventType = SessionEvent['type']

type DistributiveOptionalAt<T> = T extends unknown ? Omit<T, 'at'> & { at?: string } : never

/** What callers pass to `SessionStore.append`; `at` is filled when omitted. */
export type SessionEventInput = DistributiveOptionalAt<SessionEvent>
