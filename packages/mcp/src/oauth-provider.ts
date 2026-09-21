import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

export const DEFAULT_EXPIRY_SKEW_MS = 30_000

/** On-disk shape: client registration, tokens, PKCE verifier, OAuth state, discovery cache. */
export interface McpCredentialsFile {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens & { expires_at?: number }
  codeVerifier?: string
  state?: string
  discoveryState?: OAuthDiscoveryState
}

export function credentialsDir(home: string = homedir()): string {
  return join(home, '.shuttle', 'credentials')
}

function credentialsFile(serverName: string, home?: string): string {
  return join(credentialsDir(home), `${serverName}.json`)
}

/**
 * File-backed OAuthClientProvider: one JSON credential file per MCP server
 * under ~/.shuttle/credentials (0700 dir / 0600 file). Tokens never enter
 * config.yml nor any GET response — only this file and in-request memory.
 * Reads always hit the file so external revocation/edits take effect.
 */
export class ShuttleOAuthProvider implements OAuthClientProvider {
  constructor(
    readonly serverName: string,
    readonly redirectUrl: string,
    private readonly home?: string,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Shuttle (mcp client)',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  async state(): Promise<string> {
    const state = randomUUID()
    this.update({ state })
    return state
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.load().clientInformation
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.update({ clientInformation })
  }

  tokens(): (OAuthTokens & { expires_at?: number }) | undefined {
    return this.load().tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    const previous = this.load().tokens
    const expiresAt =
      typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : previous?.expires_at
    this.update({ tokens: { ...tokens, expires_at: expiresAt } })
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Recording only — the api layer opens the browser / hands the URL to the UI.
    this.pendingAuthorizationUrl = authorizationUrl.toString()
  }

  private pendingAuthorizationUrl: string | undefined

  /** URL recorded by the SDK auth() path when user interaction is required. */
  consumePendingAuthorizationUrl(): string | undefined {
    const url = this.pendingAuthorizationUrl
    this.pendingAuthorizationUrl = undefined
    return url
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.update({ codeVerifier })
  }

  codeVerifier(): string {
    const verifier = this.load().codeVerifier
    if (!verifier) throw new Error(`no PKCE code verifier saved for mcp server "${this.serverName}"`)
    return verifier
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.load().discoveryState
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.update({ discoveryState: state })
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') this.update({ tokens: undefined })
    if (scope === 'all' || scope === 'verifier') this.update({ codeVerifier: undefined })
    if (scope === 'all' || scope === 'discovery') this.update({ discoveryState: undefined })
    if (scope === 'all' || scope === 'client') this.update({ clientInformation: undefined, tokens: undefined })
    if (scope === 'all') this.update({ state: undefined })
  }

  /** Shuttle-side status helpers (drive listServers' auth field). */
  hasTokens(): boolean {
    return Boolean(this.load().tokens?.access_token)
  }

  isAccessTokenExpired(skewMs: number = DEFAULT_EXPIRY_SKEW_MS): boolean {
    const expiresAt = this.load().tokens?.expires_at
    if (expiresAt === undefined) return false // no expiry claimed — treat as valid
    return Date.now() + skewMs >= expiresAt
  }

  private file(): string {
    return credentialsFile(this.serverName, this.home)
  }

  private load(): McpCredentialsFile {
    try {
      if (existsSync(this.file())) {
        return JSON.parse(readFileSync(this.file(), 'utf8')) as McpCredentialsFile
      }
    } catch {
      // corrupt file: fail soft, re-register/re-authorize
    }
    return {}
  }

  private update(patch: Partial<McpCredentialsFile>): void {
    const next = { ...this.load(), ...patch }
    // Drop undefined values so "cleared" fields actually disappear.
    for (const key of Object.keys(next) as Array<keyof McpCredentialsFile>) {
      if (next[key] === undefined) delete next[key]
    }
    const file = this.file()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  }
}

export type McpAuthStatus = 'authorized' | 'unauthorized' | 'expired' | 'n/a'

export function authStatusOf(configAuth: 'none' | 'oauth' | undefined, provider?: ShuttleOAuthProvider): McpAuthStatus {
  if (configAuth !== 'oauth') return 'n/a'
  if (!provider || !provider.hasTokens()) return 'unauthorized'
  return provider.isAccessTokenExpired() ? 'expired' : 'authorized'
}
