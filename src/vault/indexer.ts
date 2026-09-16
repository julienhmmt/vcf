import { VaultError } from './errors'
import { toIndexEntry } from '../core/metadata'
import type { KvClient } from './kv'
import type { IndexEntry } from '../core/types'

export interface IndexProblem {
  readonly mount: string
  readonly path: string
  readonly error: VaultError
}

export interface IndexResult {
  readonly entries: IndexEntry[]
  /** Paths skipped because of policy or odd data. Informational. */
  readonly problems: IndexProblem[]
  /** Secrets seen, including those that produced no entry. */
  readonly scanned: number
}

export interface IndexOptions {
  readonly prefix?: string
  /** Parallel metadata reads. Default 8. */
  readonly concurrency?: number
  readonly signal?: AbortSignal | undefined
}

/**
 * Walks a mount and turns every secret into an index entry.
 *
 * Reads `metadata/` only. For kv-v1 it does not even do that: the
 * entry comes from the path alone.
 */
export async function buildIndex(kv: KvClient, options: IndexOptions = {}): Promise<IndexResult> {
  const mount = kv.mount.path
  const entries: IndexEntry[] = []
  const problems: IndexProblem[] = []
  const concurrency = Math.max(1, options.concurrency ?? 8)
  const signalOpt = options.signal ? { signal: options.signal } : {}
  let scanned = 0

  const onError = (path: string, error: VaultError) => problems.push({ mount, path, error })

  const handle = async (path: string): Promise<void> => {
    try {
      const metadata = kv.mount.version === 2 ? await kv.readMetadata(path, signalOpt) : {}
      const entry = toIndexEntry(mount, path, metadata)
      if (entry !== null) entries.push(entry)
    } catch (error) {
      if (error instanceof VaultError && error.kind !== 'network' && error.kind !== 'aborted' && error.kind !== 'timeout') {
        onError(path, error)
        return
      }
      throw error
    }
  }

  let pending: Promise<void>[] = []
  for await (const path of kv.walk(options.prefix ?? '', { ...signalOpt, onError })) {
    scanned++
    pending.push(handle(path))
    if (pending.length >= concurrency) {
      await Promise.all(pending)
      pending = []
    }
  }
  await Promise.all(pending)

  entries.sort((a, b) => a.path.localeCompare(b.path))
  problems.sort((a, b) => a.path.localeCompare(b.path))
  return { entries, problems, scanned }
}
