# @shuttle/session

Event sourcing 会话日志（照抄 dsh，简化实现）：**模型历史不另存，只从日志 derive**（README 设计原则第 1 条：Model-visible ⟺ logged）。

## 存储

append-only JSONL：`~/.shuttle/sessions/<encoded-cwd>/<session-id>/session.v1.jsonl`。encoded-cwd 把 `/` 等转义为 `-`，dsh 风格 `--tmp-work--`。文件名版本化：`SESSION_FORMAT_VERSION = 1`，文件即 `session.v<N>.jsonl`，将来演进加 `vN→vN+1` 迁移函数。每个 session 目录还带一个侧车 `session.json`（`{id, cwd, createdAt}`），供 API 跨 cwd 列出会话。

## 事件词汇（判别联合）

`turn/start {turn}`、`turn/end {error?}`、`step/start`、`step/end`、`user/message {message}`、`assistant/message {message}`、`tool/call {toolCallId,name,arguments}`、`tool/result {toolCallId,content}`。每个事件都带 `at`（ISO 时间戳）。Phase 0 只产生 turn + user + assistant，tool 事件类型已定义待用。

## 导出契约

- `SessionStore.create(cwd)` / `new SessionStore(cwd, id)`：`append(event)`（同步写盘）、`readAll()`、`deriveMessages()`。
- **崩溃恢复**：`readAll()` 逐行 JSON.parse，坏行起截断文件尾部（ftruncate），返回 committed 前缀。
- `deriveMessages()`：从 committed 前缀派生模型可见 messages；连续 `tool/call`+`tool/result` 配对成一条 `assistant.toolCalls` + 若干 `role:'tool'` 消息，配不成对的丢弃。
