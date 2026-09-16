import type { Credential, IndexEntry } from './types'

/** Data keys tried, in order, when a secret does not declare its own. */
export const DEFAULT_USERNAME_KEYS: readonly string[] = ['username', 'user', 'login', 'email']
export const DEFAULT_PASSWORD_KEYS: readonly string[] = ['password', 'pass', 'secret']

/** Secret data as returned by kv: arbitrary JSON values. */
export type SecretData = Readonly<Record<string, unknown>>

/**
 * Picks username, password and TOTP seed out of a secret's data.
 *
 * A key declared in `custom_metadata` is authoritative: if it is
 * missing from the data, the field is null rather than guessed, so a
 * typo in the metadata shows up instead of filling the wrong value.
 */
export function extractCredential(
  entry: Pick<IndexEntry, 'usernameKey' | 'passwordKey' | 'totpKey'>,
  data: SecretData,
): Credential {
  return {
    username: pick(data, entry.usernameKey, DEFAULT_USERNAME_KEYS),
    password: pick(data, entry.passwordKey, DEFAULT_PASSWORD_KEYS),
    totpSeed: pick(data, entry.totpKey, []),
  }
}

function pick(
  data: SecretData,
  declared: string | undefined,
  defaults: readonly string[],
): string | null {
  if (declared !== undefined) return asString(data[declared])

  for (const key of defaults) {
    const exact = asString(data[key])
    if (exact !== null) return exact
  }

  // Hand-written secrets are inconsistent about case (`Username`).
  const lowered = new Map<string, unknown>()
  for (const [key, value] of Object.entries(data)) {
    const lower = key.toLowerCase()
    if (!lowered.has(lower)) lowered.set(lower, value)
  }
  for (const key of defaults) {
    const loose = asString(lowered.get(key))
    if (loose !== null) return loose
  }

  return null
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}
