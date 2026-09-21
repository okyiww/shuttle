import process from 'node:process'
import { CoreError } from '@shuttle/core'
import { ConfigError } from '@shuttle/config'
import { isLlmError } from '@shuttle/llm'
import { dumpConfig } from './config-cmd.js'
import { CliError, isAbortError } from './errors.js'
import { runTurn } from './run.js'
import { printUsage } from './usage.js'
import { runWeb } from './web.js'

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    printUsage()
    return 0
  }
  if (command === 'config') {
    if (rest[0] === '--dump') {
      try {
        dumpConfig()
        return 0
      } catch (error) {
        reportError(error)
        return 1
      }
    }
    console.error(`error: unknown config subcommand: ${rest[0] ?? '(missing)'} — expected --dump`)
    return 2
  }
  if (command === 'web') {
    try {
      await runWeb(rest)
      return 0
    } catch (error) {
      if (error instanceof CliError) {
        console.error(`error: ${error.message}`)
        return 1
      }
      reportError(error)
      return 1
    }
  }
  if (command !== 'run') {
    console.error(`error: unknown command: ${command}`)
    printUsage()
    return 2
  }
  try {
    await runTurn(rest)
    return 0
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`error: ${error.message}`)
      return 2
    }
    reportError(error)
    return 1
  }
}

export function reportError(error: unknown): void {
  if (isLlmError(error)) {
    let message = `error [${error.code}] ${error.message}`
    if (error.code === 'MISSING_CREDENTIAL' && error.credentialEnv) {
      message += `\nhint: export ${error.credentialEnv}="<your-api-key>"`
    }
    console.error(message)
    return
  }
  if (error instanceof ConfigError) {
    console.error(`config error [${error.code}]: ${error.message}`)
    return
  }
  if (error instanceof CoreError) {
    console.error(`error [${error.code}]: ${error.message}`)
    return
  }
  if (isAbortError(error)) {
    console.error('aborted')
    return
  }
  console.error(error)
}

// Entry: the bin shim dynamically imports this module.
process.exitCode = await main()
