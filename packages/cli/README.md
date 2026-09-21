# @shuttle/cli

`shuttle` 命令的 headless 入口（Phase 0：单轮对话）。开发态直接从源码跑：bin shim `import 'tsx/esm'` 后动态 import `src/main.ts`（dsh 同款方式），根目录 `pnpm shuttle …` 等价。

## 命令

- `shuttle run "<prompt>" [--endpoint <name>] [--model <id>]`：加载分层 config → 注册 `OpenAiCompatibleAdapter` → 创建 session → append `turn/start` + `user/message` → `llm.stream()`：text-delta 实时写 stdout，reasoning-delta 写 stderr（前缀 `<think>`），usage 摘要写 stderr → append `assistant/message` + `turn/end` → stderr 打印 session 文件路径（stdout 保持可管道）。
- `shuttle config --dump`：打印两层配置及来源路径（只读/可写标记）+ 合并结果；输出经 `maskConfig` 脱敏，apiKey 只显示掩码。
- `shuttle --help`。

endpoint 选择顺序：`--endpoint` → `agent.endpoint` → 只有一个 endpoint 时的唯一项；都没有则 fail loud 报可用列表。model 同理：`--model` → `agent.model` → endpoint 的第一个 model。

## 错误

`LlmError` 按 code 打人类可读信息并非零退出：`MISSING_CREDENTIAL` 额外提示 `export <API_KEY_ENV>="<key>"`；`ConfigError` 带文件路径 + 行号原样输出。
