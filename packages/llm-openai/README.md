# @shuttle/llm-openai

唯一需要的模型包：`OpenAiCompatibleAdapter implements LlmAdapter`。构造收 `{ providers: Record<string, EndpointConfig> }`（route 名 = endpoint 名），两种 wire 都用全局 fetch + 手写 SSE 解析（零运行时依赖）。

## wire 与 compat

- `api: 'openai-completions'`（默认）：`POST {baseURL}/chat/completions`，`stream: true` + `stream_options.include_usage`；响应逐行解析 `data:` 帧，`[DONE]` 收尾。**finish 缓存在流末尾发出**，保证 usage 先于 finish（网关的 finish_reason 通常先于 usage 帧到达）。
- `api: 'anthropic-messages'`：`POST {baseURL}/messages`（`x-api-key` + `anthropic-version`），`message_start/message_delta` 累计 usage，`stop_reason` 映射 finish。
- `api: 'ollama'`：`POST {baseURL}/api/chat`（NDJSON 逐行解析，非 SSE），`think: true` 时 `message.thinking` → `reasoning-delta`；tool 结果按 `name`（由前一条 assistant 的 toolCalls 解析 toolCallId 得来）回传；**不发任何凭据头**，baseURL 缺省兜底 `http://localhost:11434`。
- `compat` 开关：`systemRole: 'system'|'developer'`、`maxTokensField: 'max_tokens'|'max_completion_tokens'`、`thinkingFormat: 'none'|'deepseek'`（deepseek 时若 `GenerateOptions.reasoningEffort` 存在则透传为 `reasoning_effort`）；响应侧 `reasoning_content`/`reasoning`/`thinking` 一律映射为 `reasoning-delta`。

## 失败与重试

- 凭据在**请求时**解析（不启动时报）：配置 `apiKey`（明文只存用户层）→ `apiKeyEnv` 环境变量 → `MISSING_CREDENTIAL`；错误信息区分两种缺失（`configured apiKey is empty and environment variable X is not set` / `no apiKey configured and …`），并带 `credentialEnv` 供 CLI 提示 export。
- 401→`AUTH`，429→`RATE_LIMIT`，其余 4xx/5xx→`UNEXPECTED_STATUS`（带 status 与 body 摘要，5xx 可重试）；body 命中 context-window 特征→`CONTEXT_WINDOW_EXCEEDED`；网络错误/超时→`UNEXPECTED_STATUS`（retryable）。
- `retryPolicy: { retries?, backoffMs? }`（默认 2 次 / 1000ms，指数退避）：**仅对 AUTH / RATE_LIMIT / 5xx / 网络错误重试**；已吐出 chunk 的 partial stream 不重试（避免重复 delta）。
- 尊重 `options.signal`；`timeoutMs` 默认 120s（内部 `AbortSignal.timeout` 组合）。

## 已知限制（Phase 0）

- 网关必须支持 `stream_options.include_usage`，否则 `LlmService` 会按协议报 `PROTOCOL_VIOLATION`（fail loud 是特性）。
- anthropic wire 的 tool_use input 解析失败时退化为 `{}`。
