/**
 * Token lifetime arithmetic, kept free of timers so it can be driven
 * by `chrome.alarms` in the extension and by fake clocks in tests.
 */

export interface TokenLease {
  /** Seconds the token had left when observed. 0 means no expiry (root). */
  readonly ttl: number
  readonly renewable: boolean
  /** Epoch milliseconds at which `ttl` was observed. */
  readonly observedAt: number
}

/** Renew once this fraction of the remaining TTL has elapsed. */
export const RENEW_FRACTION = 2 / 3
/** Never schedule closer than this, to avoid hammering the server. */
export const MIN_RENEW_DELAY_MS = 5_000

/** Epoch ms at which the token stops working, or null if it never does. */
export function expiresAt(lease: TokenLease): number | null {
  return lease.ttl > 0 ? lease.observedAt + lease.ttl * 1000 : null
}

export function isExpired(lease: TokenLease, now: number): boolean {
  const end = expiresAt(lease)
  return end !== null && now >= end
}

/**
 * Epoch ms at which the next renewal should run.
 *
 * @returns null when the token cannot or need not be renewed; the
 *   caller should then plan a re-login at {@link expiresAt} instead.
 */
export function nextRenewalAt(lease: TokenLease): number | null {
  if (!lease.renewable || lease.ttl <= 0) return null
  const delay = Math.max(lease.ttl * 1000 * RENEW_FRACTION, MIN_RENEW_DELAY_MS)
  return lease.observedAt + Math.min(delay, lease.ttl * 1000)
}

export type RenewalOutcome =
  /** TTL moved forward; keep renewing. */
  | 'extended'
  /**
   * The server accepted the renewal but the expiry did not move: the
   * token hit its max TTL. Only a fresh login helps from here.
   */
  | 'capped'

/**
 * Compares the lease before and after a renewal.
 *
 * Vault silently clamps renewals at `max_ttl`, so a successful call
 * alone does not mean the session was extended.
 */
export function renewalOutcome(before: TokenLease, after: TokenLease): RenewalOutcome {
  const oldEnd = expiresAt(before)
  const newEnd = expiresAt(after)
  if (oldEnd === null || newEnd === null) return 'extended'
  // One second of slack for clock granularity on the server side.
  return newEnd > oldEnd + 1000 ? 'extended' : 'capped'
}
