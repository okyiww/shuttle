# @shuttle/config

分层配置：项目 `./shuttle.config.yml`（只读基底）+ 用户 `~/.shuttle/config.yml`（可写层），加载时深合并、后者覆盖前者。文件不存在不算错；存在但解析失败 / 结构非法会 **fail loud**（报文件路径 + 行号）。

## 导出契约

- `loadConfig(cwd)` → `{ config, layers: [{ path, config, writable }] }`（项目层 `writable: false`，用户层 `writable: true`）。
- `watchConfig(cwd, cb)`：fs.watch 热更新，回调收到 `{ type: 'update', config, layers }` 或 `{ type: 'error', error }`；返回 disposer。
- `writeUserLayer(patch, { remove?, replace? })`：深合并 patch 到用户层并写盘（自动建 `~/.shuttle`，目录 0700、文件 0600——文件可能存 endpoint apiKey 与敏感 headers）；`remove` 在合并后删点路径（如 `endpoints.mock2`）；`replace` 在合并前删点路径，让 PUT 语义成为真正的**整体替换**（省略的键会消失）。
- 脱敏：`maskSecret`（前 3 + `****` + 后 4，≤7 位全掩）、`maskEndpointConfig`、`maskConfig`——所有读取路径（Web API / 配置页 YAML / CLI dump）只输出掩码后的配置，明文只留在用户层文件里。
- 类型：`ShuttleConfig`（endpoints / mcp.servers / agent / tools.guard.policies 四节）、`EndpointConfig`（含 `apiKey?` 真实密钥，仅用户层）、`AgentConfig`、`McpServersConfig`（stdio: command/args/env/cwd；streamable-http: url/headers；两者皆可 disabled、toolCallTimeoutMs）、`GuardPolicy {prefix, action: allow|ask|deny}`、`ConfigLayer`、`LoadedConfig`。
- `ConfigError`（`code: 'CONFIG_PARSE' | 'CONFIG_INVALID'`，带 `path` 与 `line?`）。

## 迷你 YAML 解析器（Phase 0 子集，零依赖）

只支持本项目配置子集：嵌套 map、字符串数组、行内 `[...]` / `{...}`、双引号/单引号字符串、布尔、数字、一行 `#` 注释。其他 YAML 语法（锚点、多行块、多文档、block map inside sequence……）一律带行号报错。

**完整 YAML 是 Phase 2 的事**（届时若子集不够用再评估引入依赖）。
