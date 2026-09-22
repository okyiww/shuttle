# @shuttle/memory

项目记忆：照抄 dsh（DeepSeek Harness）的 agent-instructions + skill 体系，外加 Shuttle 差异化的会话沉淀（distill）。

零运行时依赖，全部手写（frontmatter 解析、sha1 均用 node 内置）。

## 导出契约

- `findProjectRoot(cwd)`：向上找最近含 `.git` 的祖先，找不到回退 cwd。`shuttleDir(projectRoot)` = `<root>/.shuttle`。
- `loadAgentInstructions(projectRoot, cwd)`：`~/.shuttle/AGENTS.md`（用户全局）+ 项目根→cwd 的 `AGENTS.md`/`CLAUDE.md` 链（广→具体），按目录内容去重；渲染包在 `<system-reminder>` 里（内容中的 `</system-reminder>` 转义）。总预算 `INSTRUCTION_BUDGET_BYTES = 65536`：超预算从最宽文件开始整份丢弃，只剩最具体一份时二分截断到预算；通知 `Workspace instruction budget 65536 bytes: omitted …; truncated … from X to Y bytes` 直接进 content。单文件超 1MiB 不读。返回 `{content, omitted, truncated}`。
- `SkillLoader(projectRoot)`：`.shuttle/skills`（rank 高，近处优先）+ `~/.shuttle/skills`（rank 低），只扫一层，`<name>/SKILL.md` 或 `<name>.md` 两种形态；frontmatter 只认 `key: value` 标量行；缺 `name`/`description` 或 name 非 kebab-case → 丢弃并 `console.warn`。`category` 可取 `workflow` / `experience`，缺省为 `workflow`；`catalog()` 返回 `{name, description, category, source, digest}`；`get(name)` 返回完整文件内容（含 frontmatter）。每次调用重扫，无 watch、无缓存。

## dsh 差异

- 无 Cordis 插件/watch/增量 reconciliation：每次请求前全量重算，digest 判重后 append-only 注入（见 `@shuttle/api` 的 `context-injections.ts`）。
- 无 `.local.md` overlay、无 fs provider、无 replace-baseline 事件流。
