import { parseConfig } from './config'
import type { ExtensionConfig } from './config'
import type { Platform } from './platform'
import type { Session } from '../vault/auth'
import type { VaultErrorKind } from '../vault/errors'
import type { IndexEntry } from '../core/types'

/**
 * Typed access to the storage split. The key names and the area each
 * one lives in are the security boundary: see AGENTS.md.
 */
export const KEYS = {
  /** session area */
  session: 'vcf.session',
  /** local area */
  config: 'vcf.config',
  index: 'vcf.index',
} as const

export interface SessionState {
  readonly session: Session
  /** Epoch ms of the last user-driven action. Drives the idle lock. */
  readonly lastActivityAt: number
}

export interface StoredProblem {
  readonly mount: string
  readonly path: string
  readonly kind: VaultErrorKind
}

export interface StoredIndex {
  readonly fingerprint: string
  /** Who the index was built for: entity id or policy set. */
  readonly identity: string
  readonly entries: readonly IndexEntry[]
  readonly problems: readonly StoredProblem[]
  readonly scanned: number
  readonly builtAt: number
  /** Last failed attempt, if it came after `builtAt`. */
  readonly lastError?: { readonly at: number; readonly kind: string; readonly message: string }
}

export function sessionIdentity(session: Session): string {
  return session.entityId ?? [...session.policies].sort().join(',')
}

export class Stores {
  constructor(private readonly platform: Platform) {}

  async config(): Promise<ExtensionConfig | null> {
    const raw = await this.platform.local.get<unknown>(KEYS.config)
    if (raw === undefined) return null
    try {
      return parseConfig(raw)
    } catch {
      // A config written by an older version that no longer parses is
      // treated as absent; the setup wizard takes over.
      return null
    }
  }

  saveConfig(config: ExtensionConfig): Promise<void> {
    return this.platform.local.set(KEYS.config, config)
  }

  sessionState(): Promise<SessionState | undefined> {
    return this.platform.session.get<SessionState>(KEYS.session)
  }

  saveSessionState(state: SessionState): Promise<void> {
    return this.platform.session.set(KEYS.session, state)
  }

  clearSession(): Promise<void> {
    return this.platform.session.remove(KEYS.session)
  }

  index(): Promise<StoredIndex | undefined> {
    return this.platform.local.get<StoredIndex>(KEYS.index)
  }

  saveIndex(index: StoredIndex): Promise<void> {
    return this.platform.local.set(KEYS.index, index)
  }

  clearIndex(): Promise<void> {
    return this.platform.local.remove(KEYS.index)
  }
}
