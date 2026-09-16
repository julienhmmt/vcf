import { VaultError } from './errors'
import { sessionFromAuth, trimMount, withSignal } from './auth'
import type { AuthContext, Session } from './auth'

/**
 * Opens the IdP page and resolves with the URL the IdP redirected to.
 * In the extension this is `chrome.identity.launchWebAuthFlow`.
 */
export type AuthWindow = (authUrl: string) => Promise<string>

export interface OidcLogin {
  readonly role?: string
  /** Default `oidc`. */
  readonly mount?: string
  /**
   * Must be listed in the role's `allowed_redirect_uris`. For Chrome
   * that is `https://<extension-id>.chromiumapp.org/oidc`.
   */
  readonly redirectUri: string
  readonly openAuthWindow: AuthWindow
  readonly signal?: AbortSignal | undefined
  /** Injected for tests. */
  readonly randomNonce?: () => string
}

/**
 * Full OIDC login: ask Vault for the IdP URL, let the user sign in,
 * hand the code back to Vault.
 *
 * Vault holds the client secret and talks to the IdP; the extension
 * only ever sees the authorization code and the resulting token.
 */
export async function loginOidc(ctx: AuthContext, options: OidcLogin): Promise<Session> {
  const mount = trimMount(options.mount ?? 'oidc')
  const clientNonce = (options.randomNonce ?? randomNonce)()

  const body: Record<string, string> = {
    redirect_uri: options.redirectUri,
    client_nonce: clientNonce,
  }
  if (options.role) body.role = options.role

  const start = await ctx.http.post<{ auth_url?: string }>(
    `auth/${mount}/oidc/auth_url`,
    withSignal({ body }, options.signal),
  )
  const authUrl = start.data?.auth_url ?? ''
  if (authUrl === '') {
    // Vault answers 200 with an empty URL and a warning when the
    // redirect URI is not allowed for the role.
    const hint = start.warnings?.join('; ') || 'check allowed_redirect_uris on the role'
    throw new VaultError('invalid', `Vault refused to start OIDC login: ${hint}`)
  }

  const expectedState = new URL(authUrl).searchParams.get('state')
  const redirected = await options.openAuthWindow(authUrl)
  const { code, state } = parseOidcRedirect(redirected, options.redirectUri)

  if (expectedState !== null && state !== expectedState) {
    throw new VaultError('invalid', 'OIDC state mismatch')
  }

  const done = await ctx.http.get(
    `auth/${mount}/oidc/callback`,
    withSignal({ query: { state, code, client_nonce: clientNonce } }, options.signal),
  )
  return sessionFromAuth(done.auth, 'oidc', (ctx.now ?? Date.now)())
}

/**
 * Pulls `code` and `state` out of the redirect, refusing anything that
 * did not land on the redirect URI we registered.
 */
export function parseOidcRedirect(
  redirected: string,
  redirectUri: string,
): { code: string; state: string } {
  let url: URL
  try {
    url = new URL(redirected)
  } catch {
    throw new VaultError('invalid', 'OIDC redirect is not a URL')
  }
  const expected = new URL(redirectUri)
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new VaultError('invalid', 'OIDC redirect landed on an unexpected URL')
  }

  // Some IdPs return parameters in the fragment.
  const params = url.search !== '' ? url.searchParams : new URLSearchParams(url.hash.slice(1))

  const error = params.get('error')
  if (error !== null) {
    const description = params.get('error_description')
    throw new VaultError('invalid', `Identity provider: ${description ?? error}`)
  }

  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) throw new VaultError('protocol', 'OIDC redirect lacks code or state')
  return { code, state }
}

function randomNonce(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
