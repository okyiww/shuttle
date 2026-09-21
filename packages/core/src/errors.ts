export type CoreErrorCode = 'DUPLICATE_SERVICE' | 'MISSING_SERVICE' | 'ALREADY_DISPOSED'

export class CoreError extends Error {
  readonly code: CoreErrorCode

  constructor(code: CoreErrorCode, message: string) {
    super(message)
    this.name = 'CoreError'
    this.code = code
  }
}
