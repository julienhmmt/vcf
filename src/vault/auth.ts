import { VaultError } from './errors'
import type { RequestOptions, VaultAuthBlock, VaultHttp } from './http'

/** A usable token and what the server told us about it. */
export interface Session {
  readonly token: string
  readonly accessor: string
  readonly policies: readonly string[]
  /** Seconds left at `observedAt`. 0 means no expiry. */
  readonly ttl: number
  readonly renewable: boolean
  /** Epoch ms when `ttl` was read. */
  readonly observedAt: number
  readonly entityId?: string
  /** Where the token came from, for the UI and for re-login. */
  readonly method: AuthMethod
}

export type AuthMethod = 'token' | 'userpass' | 'ldap' | 'approle' | 'oidc'

type Signal = { readonly signal?: AbortSignal | undefined }
type Clock = () => number

export interface AuthContext {
  readonly http: VaultHttp
  readonly now?: Clock
}

export interface UserpassLogin extends Signal {
  readonly username: string
  readonly password: string
  /** Mount path of the auth method. Default `userpass`. */
  readonly mount?: string
}

export interface ApproleLogin extends Signal {
  readonly roleId: string
  readonly secretId?: string
  /** Default `approle`. */
  readonly mount?: string
}

/**
 * Username/password login. Also serves LDAP, which exposes the same
 * endpoint shape under its own mount.
 */
export async function loginUserpass(
  ctx: AuthContext,
  { username, password, mount = 'userpass', signal }: UserpassLogin,
  method: 'userpass' | 'ldap' = 'userpass',
): Promise<Session> {
  requireNonEmpty(username, 'username')
  if (username.includes('/')) throw new VaultError('invalid', 'username must not contain "/"')
  const response = await ctx.http.post(
    `auth/${trimMount(mount)}/login/${username}`,
    withSignal({ body: { password } }, signal),
  )
  return sessionFromAuth(response.auth, method, now(ctx))
}

export async function loginApprole(
  ctx: AuthContext,
  { roleId, secretId, mount = 'approle', signal }: ApproleLogin,
): Promise<Session> {
  requireNonEmpty(roleId, 'roleId')
  const body: Record<string, string> = { role_id: roleId }
  if (secretId !== undefined && secretId !== '') body.secret_id = secretId
  const response = await ctx.http.post(
    `auth/${trimMount(mount)}/login`,
    withSignal({ body }, signal),
  )
  return sessionFromAuth(response.auth, 'approle', now(ctx))
}

interface LookupSelfData {
  readonly accessor: string
  readonly policies: readonly string[] | null
  readonly ttl: number
  readonly renewable: boolean
  readonly entity_id?: string
}

/**
 * Validates a token the user pasted and returns its session.
 *
 * lookup-self is in the default policy, so a 403 here can only mean
 * the token itself is bad — the one place where Vault's ambiguous 403
 * can be read unambiguously.
 */
export async function loginToken(
  ctx: AuthContext,
  token: string,
  { signal }: Signal = {},
): Promise<Session> {
  requireNonEmpty(token, 'token')
  const data = await lookupSelf(ctx, token, { signal })
  return {
    token,
    accessor: data.accessor,
    policies: data.policies ?? [],
    ttl: data.ttl,
    renewable: data.renewable,
    observedAt: now(ctx),
    method: 'token',
    ...(data.entity_id ? { entityId: data.entity_id } : {}),
  }
}

export async function lookupSelf(
  ctx: AuthContext,
  token: string,
  { signal }: Signal = {},
): Promise<LookupSelfData> {
  try {
    const response = await ctx.http.get<LookupSelfData>(
      'auth/token/lookup-self',
      withSignal({ token }, signal),
    )
    if (response.data === null) {
      throw new VaultError('protocol', 'lookup-self returned no data')
    }
    return response.data
  } catch (error) {
    throw asUnauthenticated(error)
  }
}

/**
 * Extends the current token.
 *
 * No increment is sent: asking for one shorter than the remaining TTL
 * would shrink it. The server applies the role's default instead.
 */
export async function renewSelf(
  ctx: AuthContext,
  session: Session,
  { signal }: Signal = {},
): Promise<Session> {
  try {
    const response = await ctx.http.post(
      'auth/token/renew-self',
      withSignal({ token: session.token, body: {} }, signal),
    )
    const renewed = sessionFromAuth(response.auth, session.method, now(ctx))
    // renew-self echoes the same token; keep ours in case a proxy strips it.
    return { ...renewed, token: session.token }
  } catch (error) {
    throw asUnauthenticated(error)
  }
}

/** Best effort: a token that is already gone is not an error. */
export async function revokeSelf(
  ctx: AuthContext,
  token: string,
  { signal }: Signal = {},
): Promise<void> {
  try {
    await ctx.http.post('auth/token/revoke-self', withSignal({ token }, signal))
  } catch (error) {
    if (error instanceof VaultError && error.kind === 'permission') return
    throw error
  }
}

export function sessionFromAuth(
  auth: VaultAuthBlock | null,
  method: AuthMethod,
  observedAt: number,
): Session {
  if (auth === null || typeof auth.client_token !== 'string' || auth.client_token === '') {
    throw new VaultError('protocol', 'Login response carries no token')
  }
  const policies = auth.token_policies ?? auth.policies ?? []
  return {
    token: auth.client_token,
    accessor: auth.accessor,
    policies,
    ttl: auth.lease_duration,
    renewable: auth.renewable,
    observedAt,
    method,
    ...(auth.entity_id ? { entityId: auth.entity_id } : {}),
  }
}

function asUnauthenticated(error: unknown): unknown {
  if (error instanceof VaultError && error.kind === 'permission') {
    return new VaultError('unauthenticated', 'Token is invalid or expired', {
      ...error.details,
      cause: error,
    })
  }
  return error
}

export function trimMount(mount: string): string {
  const trimmed = mount.trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '') throw new VaultError('invalid', 'Mount path is empty')
  return trimmed
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim() === '') throw new VaultError('invalid', `${field} is required`)
}

function now(ctx: AuthContext): number {
  return (ctx.now ?? Date.now)()
}

export function withSignal<T extends RequestOptions>(
  options: T,
  signal: AbortSignal | undefined,
): T {
  return signal === undefined ? options : { ...options, signal }
}
