# @shuttle/web

Shuttle 的 Web 前端（Vite + React + TS）。**无组件库、无 tailwind**，手写精简深色 CSS，中文 UI。状态走 fetch + 手写 SSE 解析（EventSource 不能 POST）。

## 三个标签页（顶部 tab，无路由库）

1. **聊天**：左侧会话列表（新建 / 历史标题点击加载）；右侧气泡区（user/assistant、reasoning 灰色折叠块、usage 小字 footer、错误行内红条）；底部输入框 + endpoint/model 选择器（来自 `/api/config`，model 可手输）。流式渲染：POST `/api/chat` 后逐帧读 `chunk` 事件，`done` 事件带 `{sessionId, usage}`。
2. **Endpoints**：卡片列表（名字 / api / baseURL / model 数 / 默认徽标）；新增/编辑弹窗（name、api、baseURL、apiKeyEnv、models 逗号分隔、compat 高级折叠）；每卡片「测试连接」（✓ 延迟 ms / ✗ 错误信息）、「设为默认」、「删除」（默认项前端 confirm）。
3. **配置**：两层来源路径（只读/可写标注）+ 合并后 YAML 文本，标注"用户层由网页写入，项目层只读"。

## 开发 / 构建

- `pnpm --filter @shuttle/web dev` — vite dev server（:5173，`/api` proxy 到 :4080）。
- `pnpm --filter @shuttle/web build` → `dist/`，由 `shuttle web` 静态托管。
- `pnpm --filter @shuttle/web typecheck`。
