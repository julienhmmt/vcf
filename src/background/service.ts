import { VaultClient } from '../vault/client'
import { isVaultError } from '../vault/errors'
import { findMatches } from '../core/matcher'
import { parseUrl } from '../core/metadata'
import { expiresAt, isExpired, nextRenewalAt, renewalOutcome } from '../core/renewal'
import { parseTotpSeed, totp } from '../core/totp'
import { MatchQuality } from '../core/types'
import { hostPattern, indexFingerprint, parseConfig } from './config'
import { ServiceError, toWireError } from './errors'
import { Stores, sessionIdentity } from './stores'
import type { AuthMethod, Session } from '../vault/auth'
import type { KvMount } from '../vault/mounts'
import type { SessionClient } from '../vault/client'
import type { ExtensionConfig } from './config'
import type { Platform } from './platform'
import type { SessionState, StoredIndex } from './stores'

export const ALARMS = {
  renew: 'vcf:renew',
  expire: 'vcf:expire',
  idle: 'vcf:idle',
  refresh: 'vcf:refresh',
} as const

/** Retry delay after a renewal that failed for a transient reason. */
const RENEW_RETRY_MS = 60_000
/** Activity writes closer than this are skipped. */
const TOUCH_THROTTLE_MS = 30_000
const KEEPALIVE_MS = 20_000

export type LoginInput =
  | { readonly method: 'token'; readonly token: string }
  | { readonly method: 'userpass' | 'ldap'; readonly password: string }
  | { readonly method: 'approle'; readonly secretId: string }
  | { readonly method: 'oidc' }

export type LockReason = 'idle' | 'expired' | 'user' | 'config'

export interface IndexStatus {
  readonly count: number
  readonly builtAt: number | null
  readonly stale: boolean
  readonly refreshing: boolean
  readonly problems: number
  readonly lastError: { readonly at: number; readonly kind: string; readonly message: string } | null
}

export interface Status {
  readonly configured: boolean
  readonly address: string | null
  readonly unlocked: boolean
  readonly method: AuthMethod | null
  readonly expiresAt: number | null
  readonly lockAt: number | null
  readonly index: IndexStatus
}

export interface Candidate {
  readonly mount: string
  readonly path: string
  readonly title: string
  readonly quality: MatchQuality
  /** Page is plain http while the credential was not tagged for it. */
  readonly downgrade: boolean
}

export interface MatchResult {
  readonly unlocked: boolean
  readonly candidates: readonly Candidate[]
}

export interface FillRequest {
  readonly tabId: number
  readonly frameId: number
  /** URL of the frame being filled, as seen by the browser. */
  readonly frameUrl: string
  readonly mount: string
  readonly path: string
  /** User confirmed filling despite a scheme downgrade. */
  readonly allowDowngrade: boolean
}

export interface FillResult {
  readonly username: boolean
  readonly password: boolean
  readonly totp: boolean
}

/**
 * The service worker's behaviour, with no module state that matters:
 * everything that must survive the worker being killed is read from
 * storage on each call.
 */
export class BackgroundService {
  private readonly stores: Stores
  /** Deduplicates concurrent refreshes within one worker lifetime. */
  private refreshing: Promise<StoredIndex> | null = null

  constructor(private readonly platform: Platform) {
    this.stores = new Stores(platform)
  }

  // --- lifecycle ------------------------------------------------------

  /** Worker start, install or update: make alarms match storage. */
  async reconcile(): Promise<void> {
    const config = await this.stores.config()
    if (config === null) {
      await this.clearAllAlarms()
      return
    }
    await this.scheduleRefresh(config)
    const state = await this.activeState()
    if (state === null) {
      await this.clearSessionAlarms()
      return
    }
    await this.scheduleSession(state.session)
    await this.scheduleIdle(config, state.lastActivityAt)
  }

  async onAlarm(name: string): Promise<void> {
    switch (name) {
      case ALARMS.renew:
        return this.renew()
      case ALARMS.expire:
        return this.checkExpiry()
      case ALARMS.idle:
        return this.checkIdle()
      case ALARMS.refresh:
        if ((await this.activeState()) !== null) await this.refreshIndex().catch(() => undefined)
        return
    }
  }

  // --- status and configuration ---------------------------------------

  async status(): Promise<Status> {
    const config = await this.stores.config()
    const state = config ? await this.activeState() : null
    const index = await this.currentIndex(config)
    const staleAfter = (config?.refreshEveryMinutes ?? 15) * 2 * 60_000

    return {
      configured: config !== null,
      address: config?.address ?? null,
      unlocked: state !== null,
      method: state?.session.method ?? null,
      expiresAt: state ? expiresAt(state.session) : null,
      lockAt: state && config ? state.lastActivityAt + config.lockAfterMinutes * 60_000 : null,
      index: {
        count: index?.entries.length ?? 0,
        builtAt: index?.builtAt ?? null,
        stale: index === undefined || this.platform.now() - index.builtAt > staleAfter,
        refreshing: this.refreshing !== null,
        problems: index?.problems.length ?? 0,
        lastError: index?.lastError ?? null,
      },
    }
  }

  /** Non-secret: the whole config is safe to expose to the UI as-is. */
  getConfig(): Promise<ExtensionConfig | null> {
    return this.stores.config()
  }

  async saveConfig(input: unknown): Promise<Status> {
    const next = parseConfig(input)
    if (!(await this.platform.hasHostPermission(next.address))) {
      throw new ServiceError('host_permission', `Access to ${hostPattern(next.address)} was not granted`)
    }

    const previous = await this.stores.config()
    const serverChanged =
      previous !== null &&
      (previous.address !== next.address ||
        previous.namespace !== next.namespace ||
        JSON.stringify(previous.auth) !== JSON.stringify(next.auth))

    if (serverChanged) await this.lock('config')
    if (previous === null || indexFingerprint(previous) !== indexFingerprint(next)) {
      await this.stores.clearIndex()
    }

    await this.stores.saveConfig(next)
    await this.scheduleRefresh(next)
    const state = await this.activeState()
    if (state) await this.scheduleIdle(next, state.lastActivityAt)
    return this.status()
  }

  /** Setup wizard: is there a reachable, unsealed server there? */
  async probe(address: string, namespace = '') {
    const config = parseConfig({ address, namespace, auth: { method: 'token' } })
    await this.requireHostPermission(config)
    return this.vault(config).health()
  }

  // --- session --------------------------------------------------------

  async login(input: LoginInput): Promise<Status> {
    const config = await this.requireConfig()
    await this.requireHostPermission(config)
    if (input.method !== config.auth.method) {
      throw new ServiceError('bad_request', `Configured method is ${config.auth.method}`)
    }

    const session = await this.authenticate(config, input)
    const index = await this.stores.index()
    if (index && index.identity !== sessionIdentity(session)) await this.stores.clearIndex()

    const now = this.platform.now()
    await this.stores.saveSessionState({ session, lastActivityAt: now })
    await this.scheduleSession(session)
    await this.scheduleIdle(config, now)
    await this.scheduleRefresh(config)

    // The picker can list stale entries meanwhile; the UI polls status.
    void this.refreshIndex().catch(() => undefined)
    return this.status()
  }

  /** Explicit sign-out: token revoked, index dropped. */
  async logout(): Promise<void> {
    await this.lock('user')
    await this.stores.clearIndex()
  }

  async lock(reason: LockReason): Promise<void> {
    const state = await this.stores.sessionState()
    await this.stores.clearSession()
    await this.clearSessionAlarms()
    if (state === undefined || reason === 'expired') return

    // Once dropped from storage the token is useless to us; make it
    // useless to anyone else too. Best effort.
    const config = await this.stores.config()
    if (config) await this.client(config, state.session).logout().catch(() => undefined)
  }

  // --- index ----------------------------------------------------------

  refreshIndex(): Promise<StoredIndex> {
    this.refreshing ??= this.buildIndex().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async buildIndex(): Promise<StoredIndex> {
    const config = await this.requireConfig()
    const state = await this.requireState()
    const client = this.client(config, state.session)
    const previous = await this.currentIndex(config)
    const keepAlive = setInterval(() => void this.platform.keepAlive().catch(() => undefined), KEEPALIVE_MS)

    try {
      const mounts = await this.resolveMounts(config, client)
      const result = await client.buildIndex(mounts)
      const index: StoredIndex = {
        fingerprint: indexFingerprint(config),
        identity: sessionIdentity(state.session),
        entries: result.entries,
        problems: result.problems.map(({ mount, path, error }) => ({ mount, path, kind: error.kind })),
        scanned: result.scanned,
        builtAt: this.platform.now(),
      }
      await this.stores.saveIndex(index)
      return index
    } catch (error) {
      await this.handleVaultFailure(error)
      if (isVaultError(error, 'permission')) await this.verifyOrLock(client)
      if (previous) {
        const wire = toWireError(error)
        await this.stores.saveIndex({
          ...previous,
          lastError: { at: this.platform.now(), kind: wire.kind, message: wire.message },
        })
      }
      throw error
    } finally {
      clearInterval(keepAlive)
    }
  }

  private async resolveMounts(config: ExtensionConfig, client: SessionClient): Promise<KvMount[]> {
    if (config.mounts.mode === 'auto') return client.kvMounts()
    const mounts: KvMount[] = []
    for (const path of config.mounts.paths) mounts.push(await client.mount(path))
    return mounts
  }

  // --- matching and filling -------------------------------------------

  /**
   * Candidates for a page. Works while locked: the index is metadata.
   *
   * @param userAction true when a person opened the picker. Automatic
   *   lookups (content script on page load) must not keep the session
   *   unlocked.
   */
  async matches(pageUrl: string, userAction: boolean): Promise<MatchResult> {
    const config = await this.stores.config()
    const index = await this.currentIndex(config)
    const state = config ? await this.activeState() : null
    if (userAction && state && config) await this.touch(config, state)

    const page = parseUrl(pageUrl)
    if (page === null || !isWebScheme(page.scheme)) return { unlocked: state !== null, candidates: [] }

    const candidates = findMatches(pageUrl, index?.entries ?? []).map((match) => ({
      mount: match.entry.mount,
      path: match.entry.path,
      title: match.entry.title,
      quality: match.quality,
      downgrade: isDowngrade(page.scheme, match.via.scheme),
    }))
    return { unlocked: state !== null, candidates }
  }

  /**
   * The only path by which secret data leaves Vault. Always the result
   * of an explicit user action; the target is re-validated here rather
   * than trusted from the caller.
   */
  async fill(request: FillRequest): Promise<FillResult> {
    const config = await this.requireConfig()
    const page = parseUrl(request.frameUrl)
    if (page === null || !isWebScheme(page.scheme)) {
      throw new ServiceError('unsupported_page', 'Only http and https pages can be filled')
    }

    const index = await this.currentIndex(config)
    const entry = index?.entries.find((e) => e.mount === request.mount && e.path === request.path)
    const match = entry ? findMatches(request.frameUrl, [entry])[0] : undefined
    if (entry === undefined || match === undefined) {
      throw new ServiceError('no_match', 'This credential does not belong to this page')
    }
    if (isDowngrade(page.scheme, match.via.scheme) && !request.allowDowngrade) {
      throw new ServiceError('downgrade', 'Page is not using https; confirmation required')
    }

    const state = await this.requireState()
    const client = this.client(config, state.session)

    let credential
    try {
      credential = await client.readCredential(entry)
    } catch (error) {
      if (isVaultError(error, 'permission')) await this.verifyOrLock(client)
      throw error
    }

    const code = credential.totpSeed ? await this.totpCode(credential.totpSeed) : null
    await this.touch(config, state)

    try {
      await this.platform.sendToFrame(request.tabId, request.frameId, {
        type: 'vcf/fill',
        username: credential.username,
        password: credential.password,
        totp: code,
      })
    } catch {
      throw new ServiceError('no_receiver', 'The page is not ready to be filled; reload it and retry')
    }

    return {
      username: credential.username !== null,
      password: credential.password !== null,
      totp: code !== null,
    }
  }

  private async totpCode(seed: string): Promise<string | null> {
    try {
      return (await totp(parseTotpSeed(seed), this.platform.now())).code
    } catch {
      return null
    }
  }

  // --- internals ------------------------------------------------------

  private async authenticate(config: ExtensionConfig, input: LoginInput): Promise<Session> {
    const vault = this.vault(config)
    const { auth } = config
    let client: SessionClient
    if (input.method === 'token') {
      client = await vault.withToken(input.token)
    } else if (auth.method === 'userpass' && input.method === 'userpass') {
      client = await vault.withUserpass({ username: auth.username, password: input.password, mount: auth.mount })
    } else if (auth.method === 'ldap' && input.method === 'ldap') {
      client = await vault.withLdap({ username: auth.username, password: input.password, mount: auth.mount })
    } else if (auth.method === 'approle' && input.method === 'approle') {
      client = await vault.withApprole({ roleId: auth.roleId, secretId: input.secretId, mount: auth.mount })
    } else if (auth.method === 'oidc') {
      client = await vault.withOidc({
        mount: auth.mount,
        ...(auth.role ? { role: auth.role } : {}),
        redirectUri: this.platform.oidcRedirectUri(),
        openAuthWindow: (url) => this.platform.launchWebAuthFlow(url),
      })
    } else {
      throw new ServiceError('bad_request', 'Login input does not match the configured method')
    }
    return client.session
  }

  private async renew(): Promise<void> {
    const config = await this.stores.config()
    const state = await this.activeState()
    if (config === null || state === null) return

    try {
      const renewed = await this.client(config, state.session).renew()
      await this.stores.saveSessionState({ ...state, session: renewed })
      if (renewalOutcome(state.session, renewed) === 'capped') {
        await this.platform.alarms.clear(ALARMS.renew)
        await this.scheduleExpiry(renewed)
      } else {
        await this.scheduleSession(renewed)
      }
    } catch (error) {
      if (isVaultError(error, 'unauthenticated')) {
        await this.lock('expired')
        return
      }
      const retryAt = this.platform.now() + RENEW_RETRY_MS
      const end = expiresAt(state.session)
      if (end === null || retryAt < end) await this.platform.alarms.create(ALARMS.renew, { when: retryAt })
    }
  }

  private async checkExpiry(): Promise<void> {
    const state = await this.stores.sessionState()
    if (state && isExpired(state.session, this.platform.now())) await this.lock('expired')
    else if (state) await this.scheduleExpiry(state.session)
  }

  private async checkIdle(): Promise<void> {
    const config = await this.stores.config()
    const state = await this.activeState()
    if (config === null || state === null) return
    const lockAt = state.lastActivityAt + config.lockAfterMinutes * 60_000
    if (this.platform.now() >= lockAt) await this.lock('idle')
    else await this.platform.alarms.create(ALARMS.idle, { when: lockAt })
  }

  private async touch(config: ExtensionConfig, state: SessionState): Promise<void> {
    const now = this.platform.now()
    if (now - state.lastActivityAt < TOUCH_THROTTLE_MS) return
    await this.stores.saveSessionState({ ...state, lastActivityAt: now })
    await this.scheduleIdle(config, now)
  }

  /** Session state, or null when absent or already expired. */
  private async activeState(): Promise<SessionState | null> {
    const state = await this.stores.sessionState()
    if (state === undefined) return null
    if (isExpired(state.session, this.platform.now())) {
      await this.lock('expired')
      return null
    }
    return state
  }

  private async requireState(): Promise<SessionState> {
    const state = await this.activeState()
    if (state === null) throw new ServiceError('locked', 'Unlock first')
    return state
  }

  private async requireConfig(): Promise<ExtensionConfig> {
    const config = await this.stores.config()
    if (config === null) throw new ServiceError('not_configured', 'Run the setup first')
    return config
  }

  private async requireHostPermission(config: ExtensionConfig): Promise<void> {
    if (!(await this.platform.hasHostPermission(config.address))) {
      throw new ServiceError('host_permission', `Access to ${hostPattern(config.address)} was not granted`)
    }
  }

  /** Index for the current configuration, ignoring leftovers. */
  private async currentIndex(config: ExtensionConfig | null): Promise<StoredIndex | undefined> {
    if (config === null) return undefined
    const index = await this.stores.index()
    return index?.fingerprint === indexFingerprint(config) ? index : undefined
  }

  /** Vault's 403 is ambiguous: tell a dead token from a policy denial. */
  private async verifyOrLock(client: SessionClient): Promise<void> {
    await client.verify().catch((error: unknown) => this.handleVaultFailure(error))
  }

  private async handleVaultFailure(error: unknown): Promise<void> {
    if (isVaultError(error, 'unauthenticated')) await this.lock('expired')
  }

  private async scheduleSession(session: Session): Promise<void> {
    await this.platform.alarms.clear(ALARMS.renew)
    const next = nextRenewalAt(session)
    if (next !== null) await this.platform.alarms.create(ALARMS.renew, { when: next })
    await this.scheduleExpiry(session)
  }

  private async scheduleExpiry(session: Session): Promise<void> {
    const end = expiresAt(session)
    if (end === null) await this.platform.alarms.clear(ALARMS.expire)
    else await this.platform.alarms.create(ALARMS.expire, { when: end })
  }

  private scheduleIdle(config: ExtensionConfig, lastActivityAt: number): Promise<void> {
    return this.platform.alarms.create(ALARMS.idle, {
      when: lastActivityAt + config.lockAfterMinutes * 60_000,
    })
  }

  private scheduleRefresh(config: ExtensionConfig): Promise<void> {
    return this.platform.alarms.create(ALARMS.refresh, { periodInMinutes: config.refreshEveryMinutes })
  }

  private async clearSessionAlarms(): Promise<void> {
    await this.platform.alarms.clear(ALARMS.renew)
    await this.platform.alarms.clear(ALARMS.expire)
    await this.platform.alarms.clear(ALARMS.idle)
  }

  private async clearAllAlarms(): Promise<void> {
    await this.clearSessionAlarms()
    await this.platform.alarms.clear(ALARMS.refresh)
  }

  private vault(config: ExtensionConfig): VaultClient {
    return new VaultClient({
      address: config.address,
      ...(config.namespace ? { namespace: config.namespace } : {}),
      ...(this.platform.fetch ? { fetch: this.platform.fetch } : {}),
      now: () => this.platform.now(),
    })
  }

  private client(config: ExtensionConfig, session: Session): SessionClient {
    return this.vault(config).resume(session)
  }
}

function isWebScheme(scheme: string | undefined): boolean {
  return scheme === 'https' || scheme === 'http'
}

/** Plain http page, and the credential was not explicitly tagged http. */
export function isDowngrade(pageScheme: string | undefined, entryScheme: string | undefined): boolean {
  return pageScheme === 'http' && entryScheme !== 'http'
}

