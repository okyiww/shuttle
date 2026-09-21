export type ConfigErrorCode = 'CONFIG_PARSE' | 'CONFIG_INVALID'

export class ConfigError extends Error {
  readonly code: ConfigErrorCode
  /** Config file path this error belongs to, when applicable. */
  readonly path?: string
  /** 1-based line number in the config file, when applicable. */
  readonly line?: number

  constructor(code: ConfigErrorCode, message: string, options: { path?: string; line?: number; cause?: unknown } = {}) {
    super(formatMessage(code, message, options), { cause: options.cause })
    this.name = 'ConfigError'
    this.code = code
    this.path = options.path
    this.line = options.line
  }
}

function formatMessage(code: ConfigErrorCode, message: string, options: { path?: string; line?: number }): string {
  const where = options.path ? `${options.path}${options.line !== undefined ? `:${options.line}` : ''}` : undefined
  return where ? `${message} (${where})` : message
}
