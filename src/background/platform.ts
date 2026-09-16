import type { FetchLike } from '../vault/http'

/**
 * Everything the service worker needs from the browser, reduced to
 * what it actually uses. The real binding lives in
 * `browser-platform.ts`; tests use `fake-platform.test-helper.ts`.
 *
 * Keeping `chrome.*` behind this seam is what lets the whole
 * background logic run under Node.
 */
export interface StorageArea {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export interface AlarmSpec {
  /** Epoch ms for a one-shot alarm. */
  readonly when?: number
  /** Minutes between runs for a periodic alarm. */
  readonly periodInMinutes?: number
}

export interface Alarms {
  create(name: string, spec: AlarmSpec): Promise<void>
  clear(name: string): Promise<void>
}

export interface FillPayload {
  readonly type: 'vcf/fill'
  readonly username: string | null
  readonly password: string | null
  readonly totp: string | null
}

export interface Platform {
  /** In-memory, cleared on browser close. Token lives here only. */
  readonly session: StorageArea
  /** On disk. Configuration and metadata-only index. Never secrets. */
  readonly local: StorageArea
  readonly alarms: Alarms
  /** Our own extension id, to validate message senders. */
  readonly runtimeId: string
  /** `chrome-extension://<id>` or `moz-extension://<uuid>`, no slash. */
  readonly extensionOrigin: string
  now(): number
  /** Whether the Vault origin was granted at setup. */
  hasHostPermission(origin: string): Promise<boolean>
  /** URL of a tab's top frame, if we may see it. */
  tabUrl(tabId: number): Promise<string | undefined>
  /** Delivers a fill to one frame. Rejects when nothing listens there. */
  sendToFrame(tabId: number, frameId: number, payload: FillPayload): Promise<unknown>
  /** OIDC: interactive browser window. */
  launchWebAuthFlow(url: string): Promise<string>
  oidcRedirectUri(): string
  /** Any cheap extension API call: resets the worker idle timer during long work. */
  keepAlive(): Promise<void>
  /** Tests inject a fake; production uses the global fetch. */
  readonly fetch?: FetchLike
}
