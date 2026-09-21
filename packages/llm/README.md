# @shuttle/llm

Provider 中立的 LLM runtime：**零配置、零 wire 代码**。这里只有抽象与协议，HTTP/SSE 全部在 `@shuttle/llm-openai`。

## 导出契约

- `LlmAdapter` 抽象类：`info(provider)` / `resolveModel(provider, model)` / `stream(options): AsyncIterable<StreamChunk>`。
- `StreamChunk` 判别联合（**finish 是唯一 terminal，usage 必须先于 finish**）：
  - `{ type: 'text-delta', delta }`
  - `{ type: 'reasoning-delta', delta }`
  - `{ type: 'tool-call-delta', index, name?, arguments }` — arguments 保持 raw JSON string
  - `{ type: 'usage', usage: { inputTokens, outputTokens, totalTokens? } }`
  - `{ type: 'finish', reason, replayState? }`
- `Message`：`{ role: 'system'|'user'|'assistant', content }`（assistant 可带 `toolCalls?` / `reasoning?`）与 `{ role: 'tool', toolCallId, content }`；`ToolSchema`（name/description/parameters JSON Schema）。
- `LlmService`（即未来的 `ctx.llm`）：`registerAdapter(routes, adapter)` → disposer（重复 route 抛 `DUPLICATE_ADAPTER`）、`resolve(provider)`（无则 `NO_ADAPTER`）、`stream(options)` 委托 adapter 并做协议校验（usage 先于 finish；finish 后还有 chunk 抛 `PROTOCOL_VIOLATION`）。
- `LlmError`：统一错误，带 `code` / `provider` / `retryable`。错误码：`MISSING_CREDENTIAL / NO_ADAPTER / AUTH / RATE_LIMIT / CONTEXT_WINDOW_EXCEEDED / UNEXPECTED_STATUS / PROTOCOL_VIOLATION / DUPLICATE_ADAPTER`。

`GenerateOptions`：`{ provider, model, messages, tools?, temperature?, maxTokens?, signal?, purpose? }`（messages 有序，system 为 leading system message）。
