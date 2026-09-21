import type { DonePayload } from './api'

export interface ChatChunk {
  type: string
  delta?: string
  usage?: DonePayload['usage']
  reason?: string
  index?: number
  name?: string
  arguments?: string
}

export interface ToolCallEvent {
  kind: 'call'
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolResultEvent {
  kind: 'result'
  id: string
  ok: boolean
  content: string
}

export type ToolEvent = ToolCallEvent | ToolResultEvent

export interface ApprovalEvent {
  approvalId: string
  tool: string
  args: Record<string, unknown>
}

export interface ChatHandlers {
  onChunk: (chunk: ChatChunk) => void
  onDone: (done: DonePayload) => void
  onError: (message: string) => void
  onTool?: (event: ToolEvent) => void
  onApproval?: (event: ApprovalEvent) => void
}

/**
 * POST /api/chat and read the SSE stream by hand — EventSource cannot POST.
 * Frames are `event: x` + `data: json` pairs separated by blank lines.
 */
export async function streamChat(payload: unknown, handlers: ChatHandlers): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok || !response.body) {
    let message = `${response.status} ${response.statusText}`
    try {
      const parsed = (await response.json()) as { error?: string }
      if (parsed.error) message = parsed.error
    } catch {
      // keep status message
    }
    handlers.onError(message)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  let dataLines: string[] = []

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      eventName = 'message'
      return
    }
    const data = dataLines.join('\n')
    dataLines = []
    const name = eventName
    eventName = 'message'
    if (name === 'chunk') {
      try {
        handlers.onChunk(JSON.parse(data) as ChatChunk)
      } catch {
        handlers.onError(`invalid chunk payload: ${data.slice(0, 120)}`)
      }
    } else if (name === 'done') {
      handlers.onDone(JSON.parse(data) as DonePayload)
    } else if (name === 'tool') {
      try {
        handlers.onTool?.(JSON.parse(data) as ToolEvent)
      } catch {
        handlers.onError(`invalid tool payload: ${data.slice(0, 120)}`)
      }
    } else if (name === 'approval') {
      try {
        handlers.onApproval?.(JSON.parse(data) as ApprovalEvent)
      } catch {
        handlers.onError(`invalid approval payload: ${data.slice(0, 120)}`)
      }
    } else if (name === 'error') {
      let message = data
      try {
        message = String((JSON.parse(data) as { message?: string }).message ?? data)
      } catch {
        // raw string payload
      }
      handlers.onError(message)
    }
  }

  const handleLine = (raw: string): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        handleLine(line)
      }
    }
    buffer += decoder.decode()
    if (buffer !== '') handleLine(buffer)
    dispatch()
  } finally {
    reader.releaseLock()
  }
}
