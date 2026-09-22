# Shuttle

> 在 Jira 与极狐（JiHu GitLab）之间来回穿梭的任务管家：替你给同事建任务、盯进度、总结风险。

命名来自织机的**梭（Shuttle）**：它在两根经线（Jira / JiHu）之间往返穿行，把零散的任务线织成一张布。

## 定位

Shuttle 是一个**小而美的 agent harness**，**Web 优先**：本机跑 `shuttle web`，浏览器完成一切——对话派任务、配置模型、管理工具、翻会话。CLI 只保留 headless 模式给脚本用。

核心只做四件事：

1. 跑一个 turn/step 循环，驱动大模型完成任务；
2. **endpoint 自由**——模型接入与厂商解耦，任何 OpenAI 兼容网关（DeepSeek、Moonshot、公司自建网关……）都只是配置里的一行，网页上增删改；
3. 通过 MCP 接工具，开箱内置 Jira、极狐、语音备忘（voicenotes）等自有集成，网页上启停和编排；
4. 全程落会话日志，进度与风险可追溯、可复盘。

架构思想整体参考 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)：everything-is-a-plugin、event sourcing 会话、provider 中立的流式模型层、MCP 工具桥、Web UI + BFF 双层。但只保留骨架，砍掉重量（无 Cordis 依赖、无 profile/bundle 四层组合、无 sandbox/subagent/jobs）。

## 设计原则

从 dsh 抄来的不变量（三条，都是硬约束）：

1. **Model-visible ⟺ logged**：凡是进入模型请求的内容，必须能从会话日志重建。
2. **注册即 effect，可拆卸**：每一处注册（adapter、tool、listener）都返回 disposer，按逆序卸载——网页上关掉一个 MCP server 就是触发它的 disposer。
3. **配置失败要响（fail loud）**：缺 endpoint、缺 credential、工具名冲突，都在最早可判定处报错，绝不静默降级。

自己做的取舍：

- **单一循环、单一日志、单一配置轴**。不搞 capability seam 三角色形式主义——interface + 单实现即可。
- **协议差异用 `compat` 开关修，不为每个网关写 adapter**。只实现一个 OpenAI 兼容 adapter（参考 dsh 的 `llm-pi-ai`）。
- **配置文件只是存储真相，不是操作界面**。所有配置都能在网页上改；YAML 仍然存在（可 git 管理、可手写），但对用户是透明的。

## 总体架构

```
┌──────────────────────────── 浏览器 ────────────────────────────┐
│  Web UI (@shuttle/web)                                        │
│  聊天 · Endpoint 管理 · MCP 管理 · 会话浏览 · 审批/确认           │
└──────────────┬────────────────────────────────────────────────┘
               │ HTTP / SSE（JSON-RPC）
               ▼
┌──────────────────────────────────────────────────────────────┐
│  BFF (@shuttle/api)                                           │
│  托管 ctx；把 core/llm/tools/session 的能力暴露成 Web API；      │
│  配置读写（写只落用户层，热生效）                                 │
└──────┬──────────────────────┬───────────────────────────────┘
       │ ctx.llm              │ ctx.tools
       ▼                      ▼
┌──────────────┐   ┌──────────────────────────────────────────┐
│  LLM Runtime │   │  Tool Registry                            │
│  adapter 注册表│   │  · MCP client → mcp__jira__createIssue   │
│  · openai    │   │  · 内置 servers: jira / jihu / notes     │
│  · …按需增加  │   │  · guard: allow / deny / ask             │
└──────┬───────┘   └──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│  Session Log (JSONL, append-only)                             │
│  user/message · assistant/message · tool/call · tool/result    │
│  deriveMessages() 派生模型历史 · compaction 折叠旧上下文         │
└──────────────────────────────────────────────────────────────┘
```

## 包结构

pnpm workspace，包名一律 `@shuttle/<name>`，ESM，`strict: true`。

```
shuttle/
├── package.json / pnpm-workspace.yaml
├── shuttle.config.yml          # 项目默认配置（可提交，只读基底）
├── apps/
│   └── web/                    # @shuttle/web
│                               #   前端 SPA：聊天 / Endpoints / MCP / Sessions
│                               #   （Vite + React，组件化，状态走 SSE 事件）
├── packages/
│   ├── core/                   # @shuttle/core
│   │                           #   迷你插件容器（~200 行，蒸馏自 Cordis）：
│   │                           #   ctx 服务注册表 + typed events
│   │                           #   （emit/waterfall/serial）+ effect/disposer
│   ├── config/                 # @shuttle/config
│   │                           #   分层加载 + 文件监听热更新 + 写用户层
│   ├── agent/                  # @shuttle/agent   turn/step 循环 + 取消
│   ├── llm/                    # @shuttle/llm     LlmAdapter 接口 + StreamChunk
│   │                           #                  协议 + adapter 注册表（零 wire 代码）
│   ├── llm-openai/             # @shuttle/llm-openai
│   │                           #   OpenAI 兼容 adapter：completions +
│   │                           #   messages 两种 wire + compat 开关
│   ├── tools/                  # @shuttle/tools   工具注册表 + guard 门
│   ├── mcp/                    # @shuttle/mcp     MCP client（stdio + streamable-http）
│   ├── session/                # @shuttle/session JSONL 事件日志 + derive + 崩溃恢复
│   └── api/                    # @shuttle/api    BFF：HTTP + SSE，连接 Web 与 ctx
└── servers/                    # 自有 MCP servers（只保留没有官方远程 MCP 的系统）
    └── jihu/                   # 极狐 GitLab：issue / MR / pipeline
```

集成方式的既定结论：**Jira 用 Atlassian 官方远程 MCP**（`https://mcp.atlassian.com/v2/mcp`，OAuth 2.1，一次授权同时覆盖 Jira/Confluence/Bitbucket）；**voicenotes 用其官方远程 MCP**（`https://api.voicenotes.com/mcp`，OAuth 2.0）——两者都是网页上三行配置 + 点一次「授权登录」，不自建 server。只有极狐需要自己在 `servers/` 下写。

以后接新系统（钉钉？飞书？），惯例是：**在 `servers/` 下加一个 MCP server（这是写代码），然后在网页的 MCP 页把它加进来（这是配配置）**。

## 配置体系（网页优先）

三层角色，职责单一：

| 层 | 位置 | 谁能写 | 作用 |
|---|---|---|---|
| 项目默认 | `shuttle.config.yml`（仓库内） | 手写/git | 团队共享的 endpoint、MCP server 默认项 |
| 用户覆盖 | `~/.shuttle/config.yml` | **Web UI 只写这里** | 个人密钥指向、私有网关、覆盖默认 |
| 运行时 | `ctx.config` | BFF 热更新 | 网页改动即时生效，免重启 |

规则（抄 dsh，apiKey 一条按本项目的取舍调整）：

- 网页上的所有配置操作 = 对**用户层**的 CRUD，写完即热生效；项目层在 UI 上以"项目默认（只读）"形式展示；
- **apiKey 可以直接存，但只存用户层**（`~/.shuttle/config.yml` 已是 0600）：endpoint 支持 `apiKey?: string`，解析优先级 `apiKey`（配置内）→ `apiKeyEnv` 指向的环境变量 → 请求时报 `MISSING_CREDENTIAL`（错误说明缺的是哪一个）。`apiKeyEnv` 保留作回退，也是**项目层推荐写法**（团队共享的基底不该有真 key，后端不强制）；
- **所有读取路径脱敏返回**：apiKey 一律掩码（前 3 位 + `****` + 后 4 位，≤7 位全掩）——Web API、配置页 YAML、`shuttle config --dump` 都看不到明文；明文只存在于用户层文件与服务端请求时的内存里；
- 配置错误在加载时 fail loud，网页上直接显示哪一行有问题。

## Endpoint 体系（核心设计）

模型接入分两层，照抄 dsh 的 `ctx.llm` 设计：

**Runtime（@shuttle/llm）**——provider 中立，零配置零 wire 代码：

```ts
abstract class LlmAdapter {
  info(provider: string): ProviderInfo
  resolveModel(provider: string, model: string): ResolvedModel    // contextWindow 等
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  // 注册：ctx.llm.registerAdapter(['my-gateway'], adapter) → disposer
}

type StreamChunk =
  | { type: 'text-delta', delta: string }
  | { type: 'reasoning-delta', delta: string }
  | { type: 'tool-call-delta', index: number, name?, arguments: string }  // 保持 raw JSON string
  | { type: 'usage', usage: Usage }
  | { type: 'finish', reason: FinishReason, replayState?: unknown }       // 唯一 terminal，usage 必须先于它
```

**Adapter（@shuttle/llm-openai）**——唯一需要的模型包：

- `api: openai-completions | anthropic-messages | ollama` 切换 wire 协议；
- `baseURL` / `apiKey`（存用户层，读取路径全掩码）/ `apiKeyEnv`（环境变量回退）/ `headers` / `timeoutMs` / `retryPolicy`；
- `compat` 开关修正网关差异：`thinkingFormat`、`systemRole`、`maxTokensField` 等；
- 失败码 provider 中立：`NO_ADAPTER / MISSING_CREDENTIAL / RATE_LIMIT / CONTEXT_WINDOW_EXCEEDED`。

**网页上的 Endpoint 页**：列表 + 增删改表单 + **"测试连接"按钮**（发一个最小请求验证 baseURL/key/模型）+ 设默认 endpoint/model。聊天界面顶部有切换器，会话中途换模型也可以（请求级覆盖）。

```yaml
# shuttle.config.yml —— endpoint 只是数据，不是代码
endpoints:
  deepseek:
    api: openai-completions
    baseURL: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
    models: [{ id: deepseek-chat, contextWindow: 64000 }]
  company-gateway:
    api: openai-completions
    baseURL: https://llm.example.com/v1
    apiKeyEnv: COMPANY_LLM_KEY
    compat: { thinkingFormat: deepseek }
  # 本地 Ollama：免 API key，baseURL 缺省即为 http://localhost:11434
  ollama:
    api: ollama
    baseURL: http://localhost:11434
    models: [{ id: deepseek-r1:8b }]
```

切换 endpoint 的三种方式（按 dsh 的习惯）：UI 切换器（写用户层）→ agent 配置默认值 → `request` hook 请求级改写。

## 工具与 MCP

**内置工具**直接注册进 `@shuttle/tools`；**外部能力一律走 MCP**（`@shuttle/mcp`，基于官方 `@modelcontextprotocol/sdk`——本项目唯一的外部运行时依赖）。网页上的 **MCP 页**已实现，负责管理：

- 添加 server：stdio（填 command/args/env）或 streamable-http（填 URL/headers）；
- 每个 server 卡片显示：连接状态（绿/黄/红/灰）、错误文本、发现到的工具列表及 schema、启停开关、重连；
- 启停 = 执行/回卷该 server 的 effect（断开子进程、注销工具）；
- **Guard 策略**区块：`tools.guard.policies` 表格编辑（prefix → allow/ask/deny），写用户层热生效。

```yaml
# shuttle.config.yml 中的形态（网页表单的存储投影）
mcp:
  servers:
    atlassian:                  # serverName = 命名空间，本地给定，不信任远端自报名
      transport: streamable-http
      url: https://mcp.atlassian.com/v2/mcp
      auth: oauth                  # Atlassian OAuth 2.1：Jira/Confluence/Bitbucket 一次授权全覆盖
    voicenotes:
      transport: streamable-http
      url: https://api.voicenotes.com/mcp
      auth: oauth                  # OAuth 2.0：见下节
    jihu:
      transport: stdio
      command: node
      args: [./servers/jihu/dist/index.js]
```

### OAuth 服务器（如 Voicenotes）

无 API key、无预注册 client 的 MCP 服务走标准 OAuth 2.0，Shuttle 全自动：401 → RFC 9728 资源元数据 → RFC 8414 授权服务器元数据 → **RFC 7591 动态客户端注册**（client_id 持久化，重复授权不重复注册）→ **Authorization Code + PKCE(S256)** 浏览器登录（网页上点「授权登录」，自动开浏览器；开不了则给链接手动打开）→ loopback 回调 `http://127.0.0.1:<port>/api/oauth/callback`（state 防 CSRF，10 分钟超时）。

- **凭证文件**：`~/.shuttle/credentials/<serverName>.json`（目录 0700 / 文件 0600）存 client_id、access/refresh token（含过期时间）、PKCE verifier、discovery 缓存——token 是会变的密钥，**不进 config.yml 也不进任何 GET 响应**；
- **自动刷新**：连接时优先用 refresh_token 换新 access_token；refresh 被拒 → 卡片状态 `unauthorized`，点「重新授权」走一遍登录即可；
- 卡片徽标：`authorized / unauthorized / expired / n/a`（n/a = 非 OAuth server）。

运行时约定（抄 dsh）：

- 发现的工具注册为 `mcp__<serverName>__<toolName>`（名字是钉死的契约）；
- server instructions 原样进 system prompt；
- stdio 子进程从**脱敏父环境**起步（丢弃 `KEY|PASSWORD|SECRET|TOKEN`、`SHUTTLE_*`），配置 `env` 覆盖其上；
- 断线指数退避重连；发现失败保留旧一代工具，不半更新。

**guard**：`tools/pre-execute` 是 waterfall 门，`jira.createIssue` 这类写操作默认 `ask`——网页上弹出确认卡片，允许/拒绝/记住选择；读操作默认 `allow`；按工具名前缀配置。

## 会话与持久化

照抄 dsh 的 event sourcing，简化实现：

- **append-only JSONL**：每个 session 一个文件 `~/.shuttle/sessions/<encoded-id>/session.v1.jsonl`；
- 事件词汇：`turn/start|end`、`step/start|end`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`compaction/start|end`；
- `deriveMessages()` 从日志派生模型历史——**历史不另存**；
- 崩溃恢复：committed 前缀完整保留，损坏的尾部行截断丢弃；
- 格式版本化：文件名带 `vN`，当前 v1，将来演进再加 `vN→vN+1` 迁移函数；
- **compaction**：token 压力到阈值（默认 context window 的 80%）时，把旧对话折叠成一条 summary；被折叠的旧事件**仍留在日志里**，只是 derive 时跳过。

网页上的 **Sessions 页**：会话列表、续聊、按事件时间线查看（含每次工具调用与审批记录）、导出 Markdown 周报（喂给"总结风险"的工作流）。

## Agent Loop

一个循环，两种粒度（术语照抄 dsh）：

- **step** = 一次模型请求 + 它发起的工具调用；
- **turn** = 零或多个 step，直到无工具欠账。

```
turn/start
  └─ step: pre-step(request 改写) → prepareCall → stream
       → tool/call → pre-execute(guard) → execute → post-execute → tool/result
       → 还有欠账？下一个 step
turn/end
```

模型历史每 step 从日志重新 derive 并 freeze；重试不重复组装；取消是协作式的（honor `AbortSignal`）。前端流式渲染直接消费 `StreamChunk`，经 BFF 的 SSE 转发。

照抄 dsh 的两个空响应语义（`llm-retry`）：

- **EMPTY_RESPONSE 可重试**：wire 合法完成但既无正文也无工具调用（reasoning-only 也算）→ adapter 按重试策略**重发同一请求**（body 不变，不改写 prompt）。重试耗尽后抛 `EMPTY_RESPONSE`，turn 以空消息落定，UI 明确提示。
- **空内容不进派生历史**：空 assistant 消息留在日志（surface/统计），但 `deriveMessages` 排除——空轮次不会成为后续请求的上下文。

## 快速开始

```sh
pnpm install && pnpm run build
pnpm shuttle web               # 起服务，自动打开 http://127.0.0.1:4080

# 脚本/CI 仍可用 headless
pnpm shuttle run --endpoint company-gateway "汇总本周所有进行中的任务风险"
```

打开网页后的第一件事：进 **Endpoints 页**加你的网关 → 点「测试连接」→ 回聊天页派任务（同一会话可连续多轮，历史从 JSONL 日志重新 derive）。需要外部能力时进 **MCP 页**添加 server（stdio / streamable-http），发现的工具立刻可用于聊天；写操作默认弹审批卡片。

开发模式（改代码热更新）：`pnpm dev` —— 并行起 api（:4080，tsx watch + cors）和 vite（:5173，`/api` 代理到 :4080）。

## 路线图

- [x] **Phase 0 — 骨架**：core 容器 + llm/llm-openai + session + config，headless 跑通单轮对话
- [x] **Phase 1 — 循环 + 最小 Web**：`shuttle web` + Web 聊天（SSE 流式、同 session 多轮、工具调用内联卡片、审批模态）+ Endpoints 网页管理 + MCP 管理页（增删改/启停/重连/guard 策略）+ 配置页；turn/step 循环与 guard（allow/ask/deny + allow-remember）已落地
- [x] **集成方式定型**：Jira 走 Atlassian 官方远程 MCP（OAuth 2.1），voicenotes 走其官方远程 MCP（OAuth 2.0），均已在 MCP 页配置就绪（`servers/` 无需自建 jira/voicenotes）
- [ ] **Phase 2 — 自有集成与审批体验**：`servers/jihu` 自建 server 跑通"语音 → 草稿 → 建任务 → 盯进度 → 风险周报"；guard 记忆细化
- [ ] **Phase 3 — 体验**：compaction、Sessions 页（时间线/导出周报）、多 endpoint A/B

## 与 dsh 的对照

| dsh | Shuttle |
|---|---|
| Cordis（vendor） | `core` 里 ~200 行蒸馏版：ctx 注册表 + 事件 + disposer |
| bundle / profile / patch 四层组合 | 项目 `shuttle.config.yml` + 用户 `~/.shuttle/config.yml` 两层，Web UI 写用户层 |
| settings/credentials 双 seam | 合并进 `@shuttle/config` |
| `llm` + `llm-deepseek` + `llm-pi-ai` | `llm` + `llm-openai`（compat 开关吞掉网关差异） |
| apps/web + packages/api（BFF） | `apps/web` + `packages/api`（**照抄**，缩小） |
| zstd 帧 + 迁移链 + SQLite FTS | 纯 JSONL v1（检索后补） |
| sandbox / subagent / jobs / hooks / 桌面端 | 砍掉；guard 保留最小 ask/allow/deny |
| StreamChunk 协议、event sourcing、mcp__ 命名、apiKeyEnv、瀑布 hook | **原样照抄**；唯一偏离：apiKey 允许存用户层（0600 + 全路径掩码），apiKeyEnv 降为回退 |
