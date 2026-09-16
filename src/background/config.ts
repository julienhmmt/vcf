import { normaliseAddress } from '../vault/http'

export type AuthConfig =
  | { readonly method: 'token' }
  | { readonly method: 'userpass' | 'ldap'; readonly mount: string; readonly username: string }
  /** Only the role id is kept. The secret id is asked at every unlock. */
  | { readonly method: 'approle'; readonly mount: string; readonly roleId: string }
  | { readonly method: 'oidc'; readonly mount: string; readonly role: string }

export type MountSelection =
  | { readonly mode: 'auto' }
  | { readonly mode: 'manual'; readonly paths: readonly string[] }

export interface ExtensionConfig {
  readonly address: string
  readonly namespace: string
  readonly auth: AuthConfig
  readonly mounts: MountSelection
  /** Lock after this much inactivity. */
  readonly lockAfterMinutes: number
  /** Background index refresh period. */
  readonly refreshEveryMinutes: number
}

export const DEFAULTS = {
  lockAfterMinutes: 30,
  refreshEveryMinutes: 15,
} as const

const LIMITS = {
  lockAfterMinutes: [1, 24 * 60],
  refreshEveryMinutes: [1, 24 * 60],
} as const

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/**
 * Turns untrusted input (a message from the options page, or what
 * storage returned) into a config, or throws with a field-level reason.
 */
export function parseConfig(input: unknown): ExtensionConfig {
  const raw = asRecord(input, 'config')

  let address: string
  try {
    address = normaliseAddress(str(raw.address, 'address'))
  } catch {
    throw new ConfigError('address: not a valid http(s) URL')
  }

  return {
    address,
    namespace: optionalStr(raw.namespace, 'namespace').replace(/^\/+|\/+$/g, ''),
    auth: parseAuth(raw.auth),
    mounts: parseMounts(raw.mounts),
    lockAfterMinutes: minutes(raw.lockAfterMinutes, 'lockAfterMinutes'),
    refreshEveryMinutes: minutes(raw.refreshEveryMinutes, 'refreshEveryMinutes'),
  }
}

function parseAuth(input: unknown): AuthConfig {
  const raw = asRecord(input, 'auth')
  const method = raw.method
  switch (method) {
    case 'token':
      return { method }
    case 'userpass':
    case 'ldap': {
      const username = str(raw.username, 'auth.username')
      if (username.includes('/')) throw new ConfigError('auth.username: must not contain "/"')
      return { method, mount: mount(raw.mount, method), username }
    }
    case 'approle':
      return { method, mount: mount(raw.mount, method), roleId: str(raw.roleId, 'auth.roleId') }
    case 'oidc':
      return { method, mount: mount(raw.mount, method), role: optionalStr(raw.role, 'auth.role') }
    default:
      throw new ConfigError('auth.method: unsupported')
  }
}

function parseMounts(input: unknown): MountSelection {
  if (input === undefined) return { mode: 'auto' }
  const raw = asRecord(input, 'mounts')
  if (raw.mode === 'auto') return { mode: 'auto' }
  if (raw.mode !== 'manual') throw new ConfigError('mounts.mode: must be auto or manual')
  if (!Array.isArray(raw.paths)) throw new ConfigError('mounts.paths: must be a list')
  const paths = [
    ...new Set(
      raw.paths.map((p, i) => {
        const clean = str(p, `mounts.paths[${i}]`).replace(/^\/+|\/+$/g, '')
        if (clean === '') throw new ConfigError(`mounts.paths[${i}]: empty`)
        return clean
      }),
    ),
  ]
  if (paths.length === 0) throw new ConfigError('mounts.paths: at least one mount')
  return { mode: 'manual', paths }
}

function mount(value: unknown, fallback: string): string {
  const clean = optionalStr(value, 'auth.mount').replace(/^\/+|\/+$/g, '')
  return clean === '' ? fallback : clean
}

function minutes(value: unknown, field: keyof typeof LIMITS): number {
  if (value === undefined) return DEFAULTS[field]
  const [min, max] = LIMITS[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${field}: integer between ${min} and ${max}`)
  }
  return value
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${field}: must be an object`)
  }
  return value as Record<string, unknown>
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`${field}: required`)
  return value.trim()
}

function optionalStr(value: unknown, field: string): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new ConfigError(`${field}: must be a string`)
  return value.trim()
}

/**
 * Identity of what an index was built for. A different server,
 * namespace, mount selection or login identity sees a different tree,
 * so the stored index must be discarded when this changes.
 */
export function indexFingerprint(config: ExtensionConfig): string {
  const { address, namespace, auth, mounts } = config
  return JSON.stringify({ address, namespace, auth, mounts })
}

/** Origin pattern to request with `permissions.request`. */
export function hostPattern(address: string): string {
  return `${new URL(address).origin}/*`
}
