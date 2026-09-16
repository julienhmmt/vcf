import { VaultError } from './errors'
import { withSignal } from './auth'
import type { VaultHttp } from './http'
import type { KvMount } from './mounts'
import type { CustomMetadata } from '../core/types'
import type { SecretData } from '../core/credential'

interface Opts {
  readonly signal?: AbortSignal | undefined
}

export interface WalkOptions extends Opts {
  /** Parallel LIST calls. Default 4. */
  readonly concurrency?: number
  /** Directory levels below `prefix` to descend. Default 16. */
  readonly maxDepth?: number
  /** Called for subtrees that could not be listed; the walk goes on. */
  readonly onError?: (dir: string, error: VaultError) => void
}

/**
 * kv-v1 and kv-v2 behind one interface.
 *
 * Paths are relative to the mount and never start or end with `/`,
 * except directories returned by {@link list}, which keep Vault's
 * trailing slash.
 */
export class KvClient {
  constructor(
    private readonly http: VaultHttp,
    private readonly token: string,
    readonly mount: KvMount,
  ) {}

  /**
   * Keys directly under `dir`. An absent or empty directory is `[]`:
   * Vault answers 404 for both and they mean the same thing here.
   */
  async list(dir = '', { signal }: Opts = {}): Promise<string[]> {
    const path = this.v2 ? this.api('metadata', dir) : this.api(null, dir)
    try {
      const response = await this.http.list<{ keys?: unknown }>(
        `${path}/`,
        withSignal({ token: this.token }, signal),
      )
      const keys = response.data?.keys
      return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
    } catch (error) {
      if (error instanceof VaultError && error.kind === 'not_found') return []
      throw error
    }
  }

  /**
   * `custom_metadata` of a kv-v2 secret. For kv-v1, always `{}`: the
   * engine has no metadata and reading data to find out would defeat
   * the metadata/data split.
   */
  async readMetadata(path: string, { signal }: Opts = {}): Promise<CustomMetadata> {
    if (!this.v2) return {}
    const response = await this.http.get<{ custom_metadata?: CustomMetadata | null }>(
      this.api('metadata', path),
      withSignal({ token: this.token }, signal),
    )
    return { ...(response.data?.custom_metadata ?? {}) }
  }

  /**
   * Secret data, latest version.
   *
   * @throws VaultError `not_found` for missing, soft-deleted or
   *   destroyed secrets; `permission` when the policy denies data.
   */
  async readData(path: string, { signal }: Opts = {}): Promise<SecretData> {
    if (this.v2) {
      const response = await this.http.get<{ data?: SecretData | null }>(
        this.api('data', path),
        withSignal({ token: this.token }, signal),
      )
      const data = response.data?.data
      if (data === null || data === undefined) {
        throw new VaultError('not_found', 'Secret has no live version', { path })
      }
      return data
    }

    const response = await this.http.get<SecretData>(
      this.api(null, path),
      withSignal({ token: this.token }, signal),
    )
    if (response.data === null) throw new VaultError('not_found', 'Secret is empty', { path })
    return response.data
  }

  /**
   * Yields every secret path below `prefix`, breadth-first.
   *
   * A subtree the token cannot list is reported through `onError` and
   * skipped: with scoped policies that is normal, not a failure.
   * Network-level errors abort the walk.
   */
  async *walk(prefix = '', options: WalkOptions = {}): AsyncGenerator<string> {
    const concurrency = Math.max(1, options.concurrency ?? 4)
    const maxDepth = options.maxDepth ?? 16
    let level: string[] = [normaliseDir(prefix)]

    for (let depth = 0; level.length > 0 && depth <= maxDepth; depth++) {
      const next: string[] = []
      for (let i = 0; i < level.length; i += concurrency) {
        const batch = level.slice(i, i + concurrency)
        const listed = await Promise.all(batch.map((dir) => this.safeList(dir, options)))
        for (const [index, keys] of listed.entries()) {
          const dir = batch[index] ?? ''
          for (const key of keys) {
            if (key.endsWith('/')) next.push(`${dir}${key}`)
            else yield `${dir}${key}`
          }
        }
      }
      level = next
    }
  }

  private async safeList(dir: string, options: WalkOptions): Promise<string[]> {
    try {
      return await this.list(dir, options)
    } catch (error) {
      if (error instanceof VaultError && isSkippable(error)) {
        options.onError?.(dir, error)
        return []
      }
      throw error
    }
  }

  private get v2(): boolean {
    return this.mount.version === 2
  }

  private api(kind: 'data' | 'metadata' | null, path: string): string {
    const clean = path.replace(/^\/+|\/+$/g, '')
    const parts = [this.mount.path, kind, clean].filter((p) => p !== null && p !== '')
    return parts.join('/')
  }
}

function normaliseDir(prefix: string): string {
  const clean = prefix.replace(/^\/+|\/+$/g, '')
  return clean === '' ? '' : `${clean}/`
}

function isSkippable(error: VaultError): boolean {
  return error.kind === 'permission' || error.kind === 'invalid'
}
