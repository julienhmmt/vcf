import { VaultHttp } from './http'
import {
  loginApprole,
  loginToken,
  loginUserpass,
  lookupSelf,
  renewSelf,
  revokeSelf,
} from './auth'
import { loginOidc } from './oidc'
import { describeMount, discoverKvMounts, listRoots, readResultantAcl } from './mounts'
import { KvClient } from './kv'
import { buildIndex } from './indexer'
import { extractCredential } from '../core/credential'
import type { ApproleLogin, AuthContext, Session, UserpassLogin } from './auth'
import type { OidcLogin } from './oidc'
import type { VaultHttpOptions } from './http'
import type { KvMount } from './mounts'
import type { IndexOptions, IndexProblem } from './indexer'
import type { Credential, IndexEntry } from '../core/types'

export interface VaultClientOptions extends VaultHttpOptions {
  readonly now?: () => number
}

export interface ServerHealth {
  readonly initialized: boolean
  readonly sealed: boolean
  readonly standby: boolean
  readonly version: string
}

interface Signal {
  readonly signal?: AbortSignal | undefined
}

/** Entry point: an address, before any token exists. */
export class VaultClient {
  readonly http: VaultHttp
  private readonly ctx: AuthContext

  constructor(options: VaultClientOptions) {
    this.http = new VaultHttp(options)
    this.ctx = options.now ? { http: this.http, now: options.now } : { http: this.http }
  }

  /**
   * Unauthenticated probe for the setup wizard. The query flags make
   * every state answer 200 so the body can be read.
   */
  async health({ signal }: Signal = {}): Promise<ServerHealth> {
    const response = await this.http.get<never>('sys/health', {
      query: {
        standbyok: 'true',
        perfstandbyok: 'true',
        sealedcode: '200',
        uninitcode: '200',
        drsecondarycode: '200',
      },
      ...(signal ? { signal } : {}),
    })
    // sys/health is the one endpoint without the usual envelope.
    const body = response as unknown as Partial<ServerHealth>
    return {
      initialized: body.initialized ?? false,
      sealed: body.sealed ?? true,
      standby: body.standby ?? false,
      version: body.version ?? '',
    }
  }

  async withToken(token: string, opts: Signal = {}): Promise<SessionClient> {
    return this.resume(await loginToken(this.ctx, token, opts))
  }

  async withUserpass(login: UserpassLogin): Promise<SessionClient> {
    return this.resume(await loginUserpass(this.ctx, login))
  }

  async withLdap(login: UserpassLogin): Promise<SessionClient> {
    return this.resume(await loginUserpass(this.ctx, { mount: 'ldap', ...login }, 'ldap'))
  }

  async withApprole(login: ApproleLogin): Promise<SessionClient> {
    return this.resume(await loginApprole(this.ctx, login))
  }

  async withOidc(login: OidcLogin): Promise<SessionClient> {
    return this.resume(await loginOidc(this.ctx, login))
  }

  /** Rebuilds a client from a session kept in storage. No network. */
  resume(session: Session): SessionClient {
    return new SessionClient(this.ctx, session)
  }
}

/** Everything that needs a token. */
export class SessionClient {
  private current: Session
  private readonly mounts = new Map<string, KvMount>()

  constructor(
    private readonly ctx: AuthContext,
    session: Session,
  ) {
    this.current = session
  }

  get session(): Session {
    return this.current
  }

  /** Throws `unauthenticated` if the token is no longer valid. */
  async verify(opts: Signal = {}): Promise<void> {
    await lookupSelf(this.ctx, this.current.token, opts)
  }

  async renew(opts: Signal = {}): Promise<Session> {
    this.current = await renewSelf(this.ctx, this.current, opts)
    return this.current
  }

  async logout(opts: Signal = {}): Promise<void> {
    await revokeSelf(this.ctx, this.current.token, opts)
    this.mounts.clear()
  }

  async kvMounts(opts: Signal = {}): Promise<KvMount[]> {
    const found = await discoverKvMounts(this.ctx.http, this.current.token, opts)
    for (const mount of found) this.mounts.set(mount.path, mount)
    return found
  }

  async mount(path: string, opts: Signal = {}): Promise<KvMount> {
    const key = path.replace(/^\/+|\/+$/g, '')
    const known = this.mounts.get(key)
    if (known) return known
    const described = await describeMount(this.ctx.http, this.current.token, key, opts)
    this.mounts.set(described.path, described)
    return described
  }

  kv(mount: KvMount): KvClient {
    this.mounts.set(mount.path, mount)
    return new KvClient(this.ctx.http, this.current.token, mount)
  }

  /**
   * Indexes several mounts in sequence, each from the directories the
   * token may actually list. One subtree failing on policy does not
   * prevent the others from being indexed.
   */
  async buildIndex(
    mounts: readonly KvMount[],
    options: Omit<IndexOptions, 'prefix'> = {},
  ): Promise<{ entries: IndexEntry[]; problems: IndexProblem[]; scanned: number }> {
    const opts = options.signal ? { signal: options.signal } : {}
    const acl = await readResultantAcl(this.ctx.http, this.current.token, opts)
    const entries: IndexEntry[] = []
    const problems: IndexProblem[] = []
    let scanned = 0
    for (const mount of mounts) {
      const kv = this.kv(mount)
      for (const prefix of listRoots(acl, mount)) {
        const result = await buildIndex(kv, { ...options, prefix })
        entries.push(...result.entries)
        problems.push(...result.problems)
        scanned += result.scanned
      }
    }
    return { entries, problems, scanned }
  }

  /** The only call that touches secret data. */
  async readCredential(entry: IndexEntry, opts: Signal = {}): Promise<Credential> {
    const mount = await this.mount(entry.mount, opts)
    const data = await this.kv(mount).readData(entry.path, opts)
    return extractCredential(entry, data)
  }
}
