/**
 * Why a Vault call failed, reduced to what the UI needs to decide.
 *
 * - `permission`  403. Policy denies the path, or the token is dead —
 *                 Vault does not distinguish the two on regular paths.
 * - `unauthenticated` Token confirmed invalid or expired (lookup-self 403).
 * - `invalid`     400. Bad login credentials or malformed request.
 * - `not_found`   404. Includes soft-deleted kv-v2 versions.
 * - `sealed`      503. Server sealed or in standby without forwarding.
 * - `rate_limited` 429.
 * - `server`      Any other non-2xx.
 * - `network`     fetch rejected: DNS, TLS, refused, CORS.
 * - `timeout`     Our own deadline elapsed.
 * - `aborted`     Caller cancelled.
 * - `protocol`    2xx but the body is not what the API documents.
 */
export type VaultErrorKind =
  | 'permission'
  | 'unauthenticated'
  | 'invalid'
  | 'not_found'
  | 'sealed'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'protocol'

export class VaultError extends Error {
  override readonly name = 'VaultError'

  constructor(
    readonly kind: VaultErrorKind,
    message: string,
    readonly details: {
      readonly status?: number
      readonly path?: string
      /** `errors` array from the response body, verbatim. */
      readonly errors?: readonly string[]
      readonly cause?: unknown
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
  }

  get status(): number | undefined {
    return this.details.status
  }
}

export function isVaultError(error: unknown, kind?: VaultErrorKind): error is VaultError {
  return error instanceof VaultError && (kind === undefined || error.kind === kind)
}

export function kindForStatus(status: number): VaultErrorKind {
  switch (status) {
    case 400:
      return 'invalid'
    case 401:
      return 'unauthenticated'
    case 403:
      return 'permission'
    case 404:
      return 'not_found'
    case 429:
      return 'rate_limited'
    case 503:
      return 'sealed'
    default:
      return 'server'
  }
}
