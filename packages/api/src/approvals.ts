import { randomUUID } from 'node:crypto'
import type { AskDecision } from '@shuttle/tools'
import type { SseWriter } from './sse.js'

const APPROVAL_TIMEOUT_MS = 5 * 60_000

interface PendingApproval {
  tool: string
  args: Record<string, unknown>
  resolve: (decision: AskDecision) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingApproval>()

export interface ApprovalSinkOptions {
  /** Persisted when the user picks 「总是允许」. */
  onRemember?: (tool: string) => void
}

/**
 * Bridge guard-'ask' to the web UI: suspends the turn loop, emits an
 * `approval` SSE event, and resolves when POST /api/approvals/:id arrives.
 * Timeout (5 min) resolves as deny — never a hung turn.
 */
export function createApprovalSink(sse: SseWriter, options: ApprovalSinkOptions = {}): (tool: string, args: Record<string, unknown>) => Promise<AskDecision> {
  return (tool, args) =>
    new Promise<AskDecision>((resolve) => {
      const approvalId = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(approvalId)
        resolve('deny')
      }, APPROVAL_TIMEOUT_MS)
      timer.unref()
      pending.set(approvalId, {
        tool,
        args,
        resolve: (decision) => {
          clearTimeout(timer)
          resolve(decision)
        },
        timer,
      })
      sse.write('approval', { approvalId, tool, args })
    })
}

/**
 * POST /api/approvals/:id. `allow-remember` resolves as allow and appends an
 * allow-policy for the tool's full name to the user layer.
 */
export function resolveApproval(id: string, decision: AskDecision, options: ApprovalSinkOptions = {}): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  pending.delete(id)
  clearTimeout(entry.timer)
  if (decision === 'allow-remember') {
    options.onRemember?.(entry.tool)
    entry.resolve('allow')
  } else {
    entry.resolve(decision)
  }
  return true
}
