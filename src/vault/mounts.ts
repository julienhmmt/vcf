import { VaultError } from './errors'
import { trimMount, withSignal } from './auth'
import type { VaultHttp } from './http'
import type { KvVersion } from '../core/types'

export interface KvMount {
  /** Without slashes, e.g. `secret`. May contain inner slashes. */
  readonly path: string
  readonly version: KvVersion
  readonly description: string
}

interface MountInfo {
  readonly type?: string
  readonly options?: Readonly<Record<string, string>> | null
  readonly description?: string
}

/** Engine types that behave as kv. `generic` is the pre-0.8 name. */
const KV_TYPES = new Set(['kv', 'generic'])

/**
 * Lists the kv mounts this token can see.
 *
 * Uses `sys/internal/ui/mounts`, which the default policy grants and
 * which filters to mounts the token has *some* access to. `sys/mounts`
 * would need a privileged policy most users will not have.
 */
export async function discoverKvMounts(
  http: VaultHttp,
  token: string,
  { signal }: { signal?: AbortSignal | undefined } = {},
): Promise<KvMount[]> {
  const response = await http.get<{ secret?: Record<string, MountInfo> }>(
    'sys/internal/ui/mounts',
    withSignal({ token }, signal),
  )
  const secret = response.data?.secret ?? {}

  return Object.entries(secret)
    .filter(([, info]) => KV_TYPES.has(info.type ?? ''))
    .map(([path, info]) => toKvMount(path, info))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Resolves one mount the user typed by hand. Works even when the
 * mount was hidden from the listing (`listing_visibility`).
 *
 * @throws VaultError `invalid` when the path is not a kv engine.
 */
export async function describeMount(
  http: VaultHttp,
  token: string,
  mount: string,
  { signal }: { signal?: AbortSignal | undefined } = {},
): Promise<KvMount> {
  const path = trimMount(mount)
  const response = await http.get<MountInfo & { path?: string }>(
    `sys/internal/ui/mounts/${path}`,
    withSignal({ token }, signal),
  )
  const info = response.data
  if (info === null || !KV_TYPES.has(info.type ?? '')) {
    throw new VaultError('invalid', `${path}/ is not a kv mount`, { path })
  }
  // The server answers with the real mount root, which differs from
  // the input when the user typed a path inside the mount.
  return toKvMount(info.path ?? path, info)
}

function toKvMount(rawPath: string, info: MountInfo): KvMount {
  return {
    path: rawPath.replace(/^\/+|\/+$/g, ''),
    version: info.options?.version === '2' ? 2 : 1,
    description: info.description ?? '',
  }
}

interface AclPath {
  readonly capabilities?: readonly string[]
}

interface ResultantAcl {
  readonly exact_paths?: Readonly<Record<string, AclPath>>
  readonly glob_paths?: Readonly<Record<string, AclPath>>
  readonly root?: boolean
}

/**
 * The token's effective policy, as the Vault UI sees it. Granted by
 * the default policy. Null when the server refuses it.
 */
export async function readResultantAcl(
  http: VaultHttp,
  token: string,
  { signal }: { signal?: AbortSignal | undefined } = {},
): Promise<ResultantAcl | null> {
  try {
    const response = await http.get<ResultantAcl>(
      'sys/internal/ui/resultant-acl',
      withSignal({ token }, signal),
    )
    return response.data
  } catch (error) {
    if (error instanceof VaultError && (error.kind === 'permission' || error.kind === 'not_found')) {
      return null
    }
    throw error
  }
}

/**
 * Directories of `mount` the token may LIST, relative to the mount,
 * with the shallowest ones only.
 *
 * A scoped policy such as `secret/metadata/perso/*` forbids listing
 * the mount root, so a walk from `''` would find nothing. The ACL
 * tells where the walk can actually start.
 *
 * Falls back to `['']` when the ACL is unavailable or grants nothing,
 * so the walk still runs and reports the denial instead of silently
 * indexing zero secrets.
 */
export function listRoots(acl: ResultantAcl | null, mount: KvMount): string[] {
  if (acl === null || acl.root === true) return ['']

  const base = `${mount.path}/${mount.version === 2 ? 'metadata/' : ''}`
  const candidates: string[] = []

  const consider = (policyPath: string, entry: AclPath, glob: boolean): void => {
    const caps = entry.capabilities ?? []
    if (caps.includes('deny') || !caps.includes('list')) return

    if (glob && base.startsWith(policyPath)) {
      // `secret/*` or `*`: covers the whole mount.
      candidates.push('')
      return
    }
    if (!policyPath.startsWith(base)) return

    let rel = policyPath.slice(base.length)
    // A glob prefix may end mid-segment (`perso*`): list its parent.
    // An exact path is only listable when it names a directory.
    if (!glob && !rel.endsWith('/') && rel !== '') return
    rel = rel.slice(0, rel.lastIndexOf('/') + 1)

    // `+` matches one segment; the walk has to start above it.
    const segments = rel.split('/')
    const wildcard = segments.findIndex((segment) => segment.includes('+'))
    if (wildcard !== -1) rel = segments.slice(0, wildcard).map((s) => `${s}/`).join('')

    candidates.push(rel)
  }

  for (const [path, entry] of Object.entries(acl.glob_paths ?? {})) consider(path, entry, true)
  for (const [path, entry] of Object.entries(acl.exact_paths ?? {})) consider(path, entry, false)

  const unique = [...new Set(candidates)].sort()
  const roots = unique.filter((root) => !unique.some((other) => other !== root && root.startsWith(other)))
  return roots.length > 0 ? roots : ['']
}
