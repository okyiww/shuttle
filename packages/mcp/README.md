# @shuttle/mcp

MCP client：把外部能力接进 Shuttle。**本项目唯一允许的运行时外部依赖是 `@modelcontextprotocol/sdk`**——理由照 dsh：MCP  wire 协议（stdio + streamable-http、握手、schema 演进）维护成本高，用一个维护良好的官方 SDK 胜过手搓；其余所有包继续保持零运行时依赖。SDK 锁在 dependencies（`^1.30.0`）。

## 导出契约

- `McpManager`（注册为 `ctx.mcp`）：
  - `applyConfig(mcpConfig)`——diff 现有 server 集：新增连接、消失/停用 dispose、配置变更重连（JSON 比较）；从 config 热更新路径调用。
  - `reconnect(name)`、`listServers()` → `{name, transport, status: connected|connecting|error|disabled, auth, tools[], error?}`、`getSystemPromptAdditions()`（各 server instructions 拼接，供 chat 组 system prompt）、`dispose()`。
  - `setRedirectBase(url)`：OAuth loopback 回调基址（api 监听成功后设置）。
  - `authorize(name)` / `completeAuthorization(state, code, error?)`：`POST /api/mcp/servers/:name/authorize` 与 `GET /api/oauth/callback` 的后端。
- `ShuttleOAuthProvider`：file-backed `OAuthClientProvider`（凭证文件 `~/.shuttle/credentials/<serverName>.json`，目录 0700 / 文件 0600；每次读取都走文件，外部吊销/修改即时生效）。
- `sanitizedEnv()`：stdio 子进程从脱敏父环境起步——丢弃 `KEY|PASSWORD|SECRET|TOKEN` 与 `SHUTTLE_*`，配置 `env` 覆盖其上（README 规则）。

## 运行时约定（照抄 dsh）

- `serverName` 是本地命名空间（`[A-Za-z0-9_-]{1,32}`，非法 fail loud），工具注册为 **`mcp__<serverName>__<rawName>`**；JSON Schema parameters 原样透传。
- callTool 结果统一转文本：text 块取 text，其余内容块 `JSON.stringify`；`isError` 抛错（由 tools 层收成 `{ok:false}`）。
- 断线指数退避重连（500ms 起 / 上限 30s / 最多 10 次，构造可配）；**重连期间保留旧代工具；tools/list 失败不半更新**（先校验重名再原子替换）。
- 每个 server 的工具注册都是 effect，dispose 即回卷。

## OAuth 服务器（如 Voicenotes）

streamable-http server 可加 `auth: 'oauth'`（缺省 `'none'`，维持现状：静态 headers 可配 bearer）：

```yaml
mcp:
  servers:
    voicenotes:
      transport: streamable-http
      url: https://api.voicenotes.com/mcp
      auth: oauth
```

流程（全部基于 SDK 的 OAuth 扩展点，`@modelcontextprotocol/sdk/client/auth`）：401 → RFC 9728 Protected Resource Metadata → RFC 8414 Authorization Server Metadata（缓存进凭证文件）→ RFC 7591 动态客户端注册（client_id 持久化，重复授权不重复注册）→ Authorization Code + PKCE(S256)（`POST /api/mcp/servers/:name/authorize` 返回 `{openedBrowser, authorizationUrl}`，优先自动开浏览器，失败交给前端手动打开）→ loopback 回调 `http://127.0.0.1:<port>/api/oauth/callback`（state 校验防 CSRF，10 分钟超时）→ 换 token 并自动连接。

- **凭证文件**：`~/.shuttle/credentials/<serverName>.json`（目录 0700 / 文件 0600）——client_id、tokens（含 expires_at）、PKCE verifier、discovery 缓存都在这；token 是会变的密钥，**不进 config.yml 也不进任何 GET 响应**。
- **自动刷新**：连接时只要凭证里有 refresh_token，SDK 会先刷新再请求；refresh 被拒（invalid_grant 等）→ server 状态 `unauthorized` + 可读 error，重新走 authorize 即可。
- `listServers()` 每个 server 带 `auth` 字段：`authorized | unauthorized | expired | n/a`（n/a = 非 oauth）。
- server URL 变更会作废该 server 的注册与 token（换资源 = 重新授权）。
