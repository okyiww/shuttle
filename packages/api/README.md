# @shuttle/api

Shuttle BFF：node:http 手写、**零运行时依赖**（SSE 也是手写 `event:`/`data:` 帧），把 core/llm/config/session 的能力暴露给 Web UI。托管 ctx；配置写只落用户层、写完即热生效。

## 启动时组装

`loadConfig(cwd)` → ctx 注册 `config` + `llm`（LlmService）→ 按配置 endpoints 构造 `OpenAiCompatibleAdapter` 并 `registerAdapter(Object.keys(endpoints))`（effect 托管）。`watchConfig` 热更新：用户层变动 → dispose 旧 adapter 注册 → 按新合并配置重建。

## API 清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | `{ config, layers: [{path,writable}], yaml }`——**全部经 `maskConfig` 脱敏**：endpoint `apiKey` 只以掩码出现（前3+`****`+后4，≤7 位全掩） |
| PUT | `/api/config/endpoints/:name` | 新增/整体替换 endpoint → 经 `writeUserLayer` 写用户层，返回更新后合并 config（body 经 config 包结构校验，未知键 fail loud）。`apiKey` 三态：缺省/掩码串 = 保留原值（前端不回传掩码）、`""` = 清除、非空 = 设置 |
| DELETE | `/api/config/endpoints/:name` | 从用户层删除（`remove: ['endpoints.<name>']`；项目默认层只读不受影响） |
| PUT | `/api/config/agent` | 设默认 `{endpoint?, model?}`（前端「设为默认」） |
| POST | `/api/endpoints/:name/test` | 极简真实请求（首个 model，maxTokens=1）→ `{ok:true,latencyMs}` 或 `{ok:false,error}`；凭据解析与聊天同一套：`apiKey`（配置内）→ `apiKeyEnv` 环境变量 → MISSING_CREDENTIAL（区分两种缺失并给出 env 提示） |
| GET | `/api/sessions` | `[{id, cwd, title(首条 user/message 截 40 字), updatedAt}]`，跨 cwd 扫描 |
| GET | `/api/sessions/:id/events` | 该 session 全部事件（渲染历史） |
| POST | `/api/chat` | body `{sessionId?, message, endpoint?, model?}` → SSE：`chunk`（StreamChunk JSON）、`tool`（`{kind:'call'|'result'}`）、`approval`（guard=ask 时挂起等待）、最后 `done`（`{sessionId, usage, finishReason}`）；错误发 `error` 事件后 200 流内结束。完整 turn/step 循环：system = 基础人设 + MCP instructions；每 step 从日志 derive messages；模型欠工具账时 append `assistant/message(toolCalls)` + `tool/call` → guard+execute（≤10 并发）→ `tool/result`，循环至无欠账 |
| GET | `/api/mcp` | `manager.listServers()`：`{name, transport, status: connected\|connecting\|error\|disabled, tools[], error?}` |
| PUT / DELETE | `/api/config/mcp/servers/:name` | 新增/替换/移除 MCP server（用户层，热应用：连接/dispose/重连） |
| POST | `/api/mcp/servers/:name/reconnect` | 立即重连 |
| POST | `/api/mcp/servers/:name/authorize` | OAuth 流程（RFC 9728→8414→7591→PKCE）→ `{openedBrowser, authorizationUrl}`；优先自动开浏览器 |
| GET | `/api/oauth/callback` | loopback 授权回调（浏览器 HTML 落地页；state 校验防 CSRF，10 分钟超时） |
| GET / PUT | `/api/config/tools-guard` | guard policies 查询 / 整体替换（用户层） |
| POST | `/api/approvals/:id` | body `{decision: 'allow'\|'deny'\|'allow-remember'}`；5 分钟超时按 deny；remember 追加 `{prefix: 工具全名, action: 'allow'}` 到用户层 |

预检/CORS：`cors: true`（dev）时放行 localhost origin 并处理 OPTIONS；生产模式同源无需 CORS。静态托管：`staticDir` 存在则托管 SPA（正确 content-type，路径穿越防护，无 fallback——SPA 无路由）。

## 开发

`pnpm --filter @shuttle/api dev`（tsx watch，端口 4080，cors 开）。
