# @shuttle/tools

工具注册表 + guard 门（照抄 dsh 的 `tools/pre-execute` 瀑布 hook）。

## 导出契约

- `ToolService`（注册为 `ctx.tools`）：`register(tool)` → disposer（重名抛 `DUPLICATE_TOOL`）；`resolve(name)`（缺失抛 `MISSING_TOOL`）；`list()` 全部模型可见 schema；`executeTool(name, args, opts)`。
- `Tool`：`{ name, description, parameters(JSON Schema 对象，原样透传给模型), execute(args, ctx) }`。
- guard：`tools/pre-execute` **waterfall**（core 的 waterfall，value 为 `ToolGate {tool, args, action, reason?}`）。初始 action 来自配置 `tools.guard.policies`（tool 名**最长前缀**匹配，默认 `allow`），listener 可改写/短路。
- `executeTool` 流程：解析策略 → waterfall → 执行。`deny` 直接拒（理由进 content 给模型）；`ask` 交 `opts.onAsk` 决定（API 层弹审批、CLI headless 自动拒/`--yes` 全允）；工具体抛错捕获为 `{ok:false, content}`——**抛错的工具绝不崩循环**。

## 已注册即 effect

每个 `register` 返回 disposer；`@shuttle/mcp` 在 server 断开/重连时执行/回卷对应工具集。
