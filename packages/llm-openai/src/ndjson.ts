/**
 * Minimal NDJSON line parser for Ollama's /api/chat stream: one JSON object
 * per line, lines may be split across arbitrary chunk boundaries.
 */
export async function* readNdjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''

  const handleLine = (raw: string): string | undefined => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    return line.trim() === '' ? undefined : line
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
  } finally {
    reader.releaseLock()
  }
}
