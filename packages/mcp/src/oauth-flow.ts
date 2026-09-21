import {
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { ShuttleOAuthProvider } from './oauth-provider.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js'

export interface OAuthFlowContext {
  authorizationServerUrl: string
  authorizationServerMetadata?: AuthorizationServerMetadata
  resourceMetadata?: OAuthProtectedResourceMetadata
  clientInformation: OAuthClientInformationMixed
}

export interface PendingFlow extends OAuthFlowContext {
  serverName: string
  state: string
  redirectUrl: string
  startedAt: number
  timer: NodeJS.Timeout
}

export const OAUTH_FLOW_TIMEOUT_MS = 10 * 60_000

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Begin an authorization flow: RFC 9728 resource metadata → RFC 8414
 * authorization server metadata (cached in the credential file), RFC 7591
 * dynamic client registration (skipped when a client_id is already stored),
 * then the Authorization Code + PKCE(S256) URL. Fail loud at every step.
 */
export async function beginAuthorization(
  serverName: string,
  serverUrl: string,
  provider: ShuttleOAuthProvider,
): Promise<{ authorizationUrl: string; state: string; flow: OAuthFlowContext }> {
  const target = new URL(serverUrl)
  const cached = await provider.discoveryState()
  let authorizationServerUrl: string
  let metadata: AuthorizationServerMetadata | undefined
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined

  if (cached?.authorizationServerUrl) {
    authorizationServerUrl = cached.authorizationServerUrl
    metadata =
      cached.authorizationServerMetadata ??
      (await discoverAuthorizationServerMetadata(authorizationServerUrl))
    resourceMetadata = cached.resourceMetadata
  } else {
    const info = await discoverOAuthServerInfo(target)
    authorizationServerUrl = info.authorizationServerUrl
    metadata = info.authorizationServerMetadata
    resourceMetadata = info.resourceMetadata
    if (!authorizationServerUrl) {
      throw new Error('no authorization server advertised (RFC 9728 metadata has no authorization_servers)')
    }
    await provider.saveDiscoveryState({
      authorizationServerUrl,
      authorizationServerMetadata: metadata,
      resourceMetadata,
    })
  }

  // DCR is idempotent across authorize calls: a stored client_id is reused.
  let clientInformation = await provider.clientInformation()
  if (!clientInformation) {
    if (!metadata) {
      metadata = await discoverAuthorizationServerMetadata(authorizationServerUrl)
    }
    const registered = await registerClient(authorizationServerUrl, {
      metadata,
      clientMetadata: provider.clientMetadata,
    })
    await provider.saveClientInformation(registered)
    clientInformation = registered
  }

  const state = await provider.state()
  const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
    metadata,
    clientInformation,
    redirectUrl: provider.redirectUrl,
    state,
    resource: target,
  })
  await provider.saveCodeVerifier(codeVerifier)

  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    flow: { authorizationServerUrl, authorizationServerMetadata: metadata, resourceMetadata, clientInformation },
  }
}

/** Exchange the callback's authorization code for tokens (PKCE verified server-side). */
export async function finishAuthorization(flow: OAuthFlowContext, provider: ShuttleOAuthProvider, code: string): Promise<void> {
  const codeVerifier = provider.codeVerifier()
  const tokens = await exchangeAuthorization(flow.authorizationServerUrl, {
    metadata: flow.authorizationServerMetadata,
    clientInformation: flow.clientInformation,
    authorizationCode: code,
    codeVerifier,
    redirectUri: provider.redirectUrl,
  })
  await provider.saveTokens(tokens)
}

export function describeOAuthError(error: unknown): string {
  return describe(error)
}
