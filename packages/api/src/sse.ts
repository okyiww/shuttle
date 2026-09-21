import type { ServerResponse } from 'node:http'

/** Hand-written SSE writer (`event:`/`data:` frames), zero deps. */
export class SseWriter {
  constructor(private readonly res: ServerResponse) {}

  write(event: string, data: unknown): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    this.res.write(`event: ${event}\ndata: ${payload}\n\n`)
  }

  end(): void {
    this.res.end()
  }
}

export function startSse(res: ServerResponse): SseWriter {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  return new SseWriter(res)
}
