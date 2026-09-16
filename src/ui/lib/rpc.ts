import { send } from './messaging'
import type { ExtensionConfig } from '../../background/config'
import type { LoginInput, MatchResult, Status } from '../../background/service'
import type { ServerHealth } from '../../vault/client'

export interface RefreshResult {
  readonly count: number
  readonly problems: number
  readonly builtAt: number
}

export interface FillOutcome {
  readonly username: boolean
  readonly password: boolean
  readonly totp: boolean
}

/**
 * One typed function per message the UI is allowed to send (see
 * `docs/messaging.md`). Components call these, never `send` directly,
 * so every call site typechecks against the service worker's contract.
 */
export const rpc = {
  status: () => send<Status>({ type: 'status' }),

  getConfig: () => send<ExtensionConfig | null>({ type: 'config/get' }),

  probe: (address: string, namespace?: string) =>
    send<ServerHealth>(namespace === undefined ? { type: 'probe', address } : { type: 'probe', address, namespace }),

  saveConfig: (config: unknown) => send<Status>({ type: 'config/save', config }),

  login: (input: LoginInput) => send<Status>({ type: 'login', input }),

  logout: () => send<void>({ type: 'logout' }),

  lock: () => send<void>({ type: 'lock' }),

  refreshIndex: () => send<RefreshResult>({ type: 'index/refresh' }),

  matchesForTab: (tabId: number) => send<MatchResult>({ type: 'matches/tab', tabId }),

  fill: (params: { tabId: number; mount: string; path: string; allowDowngrade: boolean }) =>
    send<FillOutcome>({ type: 'fill', ...params }),
}
