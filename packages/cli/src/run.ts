import process from 'node:process'
import { BASE_SYSTEM_PROMPT, runTurnLoop } from '@shuttle/api'
import { loadConfig } from '@shuttle/config'
import { Context } from '@shuttle/core'
import { LlmService } from '@shuttle/llm'
import { McpManager } from '@shuttle/mcp'
import { OpenAiCompatibleAdapter } from '@shuttle/llm-openai'
import { SessionStore } from '@shuttle/session'
import { ToolService } from '@shuttle/tools'
import { CliError } from './errors.js'

export interface RunArgs {
  prompt: string
  endpoint?: string
  model?: string
  yes: boolean
}

export function parseRunArgs(argv: string[]): RunArgs {
  let prompt: string | undefined
  let endpoint: string | undefined
  let model: string | undefined
  let yes = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--endpoint') endpoint = takeValue(argv, ++i, '--endpoint')
    else if (arg.startsWith('--endpoint=')) endpoint = arg.slice('--endpoint='.length)
    else if (arg === '--model') model = takeValue(argv, ++i, '--model')
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
    else if (arg === '--yes') yes = true
    else if (arg.startsWith('--')) throw new CliError(`unknown flag: ${arg}`)
    else if (prompt !== undefined) throw new CliError(`unexpected extra argument: ${arg} (quote the prompt as one argument)`)
    else prompt = arg
  }
  if (prompt === undefined || prompt === '') {
    throw new CliError('missing prompt — usage: shuttle run "<prompt>" [--endpoint <name>] [--model <id>] [--yes]')
  }
  return { prompt, endpoint, model, yes }
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`${flag} requires a value`)
  }
  return value
}

export async function runTurn(argv: string[]): Promise<void> {
  const args = parseRunArgs(argv)
  const cwd = process.cwd()
  const loaded = loadConfig(cwd)
  const config = loaded.config
  const endpoints = config.endpoints ?? {}
  const names = Object.keys(endpoints)

  const endpointName = args.endpoint ?? config.agent?.endpoint ?? (names.length === 1 ? names[0] : undefined)
  if (!endpointName) {
    throw new CliError(
      names.length === 0
        ? 'no endpoints configured — add one to ./shuttle.config.yml or ~/.shuttle/config.yml'
        : `no endpoint selected — pass --endpoint <name> (available: ${names.join(', ')})`,
    )
  }
  const endpoint = endpoints[endpointName]
  if (!endpoint) {
    throw new CliError(`unknown endpoint: ${endpointName} (available: ${names.join(', ')})`)
  }
  const model = args.model ?? config.agent?.model ?? endpoint.models?.[0]?.id
  if (!model) {
    throw new CliError(`no model configured for endpoint "${endpointName}" — pass --model <id>`)
  }

  const ctx = new Context()
  const llm = new LlmService(ctx)
  const tools = new ToolService(ctx)
  const mcp = new McpManager(tools)
  ctx.register('tools', tools)
  ctx.register('config', loaded)
  // Registration is an effect: disposing the context un-registers everything.
  ctx.effect(() => llm.registerAdapter(names, new OpenAiCompatibleAdapter({ providers: endpoints })))
  mcp.applyConfig(config.mcp)

  try {
    const session = SessionStore.create(cwd)
    const turn = session.readAll().filter((event) => event.type === 'turn/start').length + 1
    session.append({ type: 'turn/start', turn })
    session.append({ type: 'user/message', message: { role: 'user', content: args.prompt } })

    const systemPrompt = [BASE_SYSTEM_PROMPT, mcp.getSystemPromptAdditions()].filter(Boolean).join('\n\n')
    const summarize = (text: string): string => (text.length > 160 ? `${text.slice(0, 160)}…` : text)

    const outcome = await runTurnLoop(
      { llm, tools, session, provider: endpointName, model, systemPrompt, waitForTools: () => mcp.settle(10_000) },
      {
        onChunk: (chunk) => {
          if (chunk.type === 'text-delta') process.stdout.write(chunk.delta)
          else if (chunk.type === 'reasoning-delta') {
            if (chunk.delta) process.stderr.write(`<think> ${chunk.delta}`)
          } else if (chunk.type === 'usage') {
            process.stderr.write(`\n[usage] ${chunk.usage.inputTokens} in / ${chunk.usage.outputTokens} out\n`)
          } else if (chunk.type === 'finish') {
            process.stdout.write('\n')
          }
        },
        onToolCall: (call) => {
          process.stderr.write(`\n[tool] ${call.name}(${summarize(call.arguments)})\n`)
        },
        onToolResult: (call, result) => {
          const mark = result.ok ? '✓' : '✗'
          process.stderr.write(`[tool-result] ${mark} ${call.name}: ${summarize(result.content)}\n`)
        },
        onAsk: (call) => {
          if (args.yes) {
            process.stderr.write(`[guard] 自动允许 ${call.name}（--yes）\n`)
            return 'allow'
          }
          process.stderr.write(`[guard] ${call.name} 需要审批 —— headless 模式默认拒绝（重跑加 --yes 可全部自动允许）\n`)
          return 'deny'
        },
      },
    )
    void outcome
    process.stderr.write(`session: ${session.file}\n`)
  } finally {
    await mcp.dispose()
    await ctx.dispose()
  }
}
