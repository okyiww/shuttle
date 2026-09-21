/**
 * Minimal hand-rolled SSE parser (Phase 0: zero-dependency invariant).
 * Yields each `data:` frame payload; `[DONE]` arrives as a payload like any
 * other and is the caller's terminator.
 */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let dataLines: string[] = []

  const handleLine = (raw: string): string | undefined => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') {
      if (dataLines.length === 0) return undefined
      const payload = dataLines.join('\n')
      dataLines = []
      return payload
    }
    if (line.startsWith(':')) return undefined
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    // event: / id: / retry: lines are ignored — the wires key off payload JSON.
    return undefined
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const payload = handleLine(line)
        if (payload !== undefined) yield payload
      }
    }
    pending += decoder.decode()
    if (pending !== '') {
      const payload = handleLine(pending)
      if (payload !== undefined) yield payload
    }
    if (dataLines.length > 0) yield dataLines.join('\n')
  } finally {
    reader.releaseLock()
  }
}
