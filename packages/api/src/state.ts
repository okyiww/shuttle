import type { LoadedConfig } from '@shuttle/config'
import { loadConfig, watchConfig } from '@shuttle/config'
import type { Disposer } from '@shuttle/core'
import { Context } from '@shuttle/core'
import { LlmService } from '@shuttle/llm'
import { McpManager } from '@shuttle/mcp'
import { OpenAiCompatibleAdapter } from '@shuttle/llm-openai'
import { findProjectRoot, SkillLoader } from '@shuttle/memory'
import { ToolService } from '@shuttle/tools'

export interface ApiState {
  readonly ctx: Context
  readonly llm: LlmService
  readonly tools: ToolService
  readonly mcp: McpManager
  readonly skills: SkillLoader
  /** Latest merged config; swapped (never mutated) on hot reload. */
  readonly loaded: LoadedConfig
  /** Re-read config from disk and swap in fresh registrations. */
  reloadConfig(): void
  dispose(): Promise<void>
}

/**
 * Assemble the BFF context: `config` + `llm` + `tools` + `mcp` services, one
 * adapter registered for every configured endpoint. `watchConfig`
 * hot-reloads: a user-layer change disposes stale registrations and rebuilds
 * from the new merge — endpoint edits land in the adapter registry, MCP
 * edits in connected servers and their tools, guard edits in the gate.
 */
export function createState(cwd: string): ApiState {
  const ctx = new Context()
  const llm = new LlmService(ctx)
  const tools = new ToolService(ctx)
  const mcp = new McpManager(tools)
  const skills = new SkillLoader(findProjectRoot(cwd))
  ctx.register('tools', tools)
  ctx.register('mcp', mcp)
  // dsh 两段式 skill 消费：目录注入 `<available_skills>` 摘要（chat 前），
  // 模型用本工具取全文。找不到时抛错 → ToolService 捕获为 {ok:false, content}。
  tools.register({
    name: 'skill',
    description: '加载指定 skill 的完整内容。目录中的描述只是摘要，实际使用skill前必须调用本工具获取全文。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'skill 名' } },
      required: ['name'],
    },
    execute: (args) => {
      const name = typeof args.name === 'string' ? args.name : ''
      const content = skills.get(name)
      if (content === undefined) throw new Error(`skill not found: ${name}`)
      return `<skill_content>\n${content}\n</skill_content>`
    },
  })
  let loaded: LoadedConfig
  let configDisposer: Disposer | undefined
  let adapterDisposer: Disposer | undefined

  const commit = (next: LoadedConfig): void => {
    adapterDisposer?.()
    configDisposer?.()
    loaded = next
    configDisposer = ctx.register('config', next)
    adapterDisposer = ctx.effect(() =>
      llm.registerAdapter(
        Object.keys(next.config.endpoints ?? {}),
        new OpenAiCompatibleAdapter({ providers: next.config.endpoints ?? {} }),
      ),
    )
    mcp.applyConfig(next.config.mcp)
  }

  commit(loadConfig(cwd))
  const stopWatching = watchConfig(cwd, (event) => {
    if (event.type === 'update') {
      commit({ config: event.config, layers: event.layers })
    } else {
      console.error('[api] config reload failed:', event.error)
    }
  })

  return {
    ctx,
    llm,
    tools,
    mcp,
    skills,
    get loaded() {
      return loaded
    },
    reloadConfig: () => commit(loadConfig(cwd)),
    async dispose() {
      stopWatching()
      await mcp.dispose()
      await ctx.dispose()
    },
  }
}

/** Base persona; MCP server instructions are appended per request. */
export const BASE_SYSTEM_PROMPT =
  '你是 Shuttle，用户的任务管家：替用户派任务、盯进度、总结风险。回答简洁，使用中文。' +
  '需要工具时直接发起调用；工具结果会以 role=tool 的消息提供给你。'
