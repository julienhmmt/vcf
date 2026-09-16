import { afterEach, describe, expect, test, vi } from 'vitest'
import { ALARMS, BackgroundService, isDowngrade } from './service'
import { KEYS } from './stores'
import { fakePlatform } from './fake-platform.test-helper'
import { authReply, denied, fakeVault, listReply } from '../vault/fake-server.test-helper'
import type { FakeReply, RecordedCall } from '../vault/fake-server.test-helper'
import type { StoredIndex } from './stores'

const ADDRESS = 'https://vault.example.net'

type Routes = Record<string, FakeReply | ((call: RecordedCall) => FakeReply)>

function vaultRoutes(extra: Routes = {}): Routes {
  return {
    'POST auth/userpass/login/julien': authReply('s.user', { entity_id: 'ent-julien' }),
    'POST auth/ldap/login/julien': authReply('s.ldap'),
    'POST auth/approle/login': authReply('s.approle'),
    'GET auth/token/lookup-self': {
      body: { data: { accessor: 'a', policies: ['vcf'], ttl: 3600, renewable: true, entity_id: 'ent-julien' } },
    },
    'POST auth/token/renew-self': authReply('s.user', { lease_duration: 3600 }),
    'POST auth/token/revoke-self': { status: 204 },
    'GET sys/health': { body: { initialized: true, sealed: false, standby: false, version: '2.6.2' } },
    'GET sys/internal/ui/resultant-acl': {
      body: { data: { glob_paths: { 'secret/metadata/': { capabilities: ['list', 'read'] } } } },
    },
    'GET sys/internal/ui/mounts': {
      body: { data: { secret: { 'secret/': { type: 'kv', options: { version: '2' } } } } },
    },
    'GET sys/internal/ui/mounts/secret': {
      body: { data: { type: 'kv', path: 'secret/', options: { version: '2' } } },
    },
    'LIST secret/metadata/': listReply(['gitlab', 'legacy-site', 'mail', 'grafana', 'plain']),
    'GET secret/metadata/gitlab': meta({ url: 'https://gitlab.example.net', title: 'GitLab' }),
    'GET secret/metadata/legacy-site': meta({ url: 'legacy.example.org', title: 'Legacy' }),
    'GET secret/metadata/plain': meta({ url: 'http://intranet.example.com' }),
    'GET secret/metadata/mail': meta({ url: 'https://mail.example.net', totp_key: 'totp' }),
    'GET secret/metadata/grafana': meta({ url: 'https://grafana.example.net' }),
    'GET secret/data/gitlab': data({ username: 'julien', password: 'gitlab-pass' }),
    'GET secret/data/legacy-site': data({ username: 'old', password: 'old-pass' }),
    'GET secret/data/plain': data({ password: 'plain-pass' }),
    'GET secret/data/mail': data({ email: 'j@example.net', password: 'mail-pass', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }),
    'GET secret/data/grafana': denied,
    ...extra,
  }
}

function meta(custom: Record<string, string>): FakeReply {
  return { body: { data: { custom_metadata: custom } } }
}

function data(values: Record<string, string>): FakeReply {
  return { body: { data: { data: values } } }
}

const userpassConfig = {
  address: ADDRESS,
  auth: { method: 'userpass', username: 'julien' },
  lockAfterMinutes: 10,
  refreshEveryMinutes: 15,
}

function setup(extra: Routes = {}) {
  const server = fakeVault(vaultRoutes(extra))
  const platform = fakePlatform(server.fetch)
  const service = new BackgroundService(platform)
  return { platform, service, calls: server.calls }
}

async function unlocked(extra: Routes = {}) {
  const ctx = setup(extra)
  await ctx.service.saveConfig(userpassConfig)
  await ctx.service.login({ method: 'userpass', password: 'pw' })
  await ctx.service.refreshIndex()
  return ctx
}

function fillRequest(overrides: Partial<Parameters<BackgroundService['fill']>[0]> = {}) {
  return {
    tabId: 7,
    frameId: 0,
    frameUrl: 'https://gitlab.example.net/users/sign_in',
    mount: 'secret',
    path: 'gitlab',
    allowDowngrade: false,
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('configuration', () => {
  test('unconfigured status', async () => {
    const { service } = setup()
    expect(await service.status()).toEqual({
      configured: false,
      address: null,
      unlocked: false,
      method: null,
      expiresAt: null,
      lockAt: null,
      index: { count: 0, builtAt: null, stale: true, refreshing: false, problems: 0, lastError: null },
    })
  })

  test('requires the host permission', async () => {
    const { service, platform } = setup()
    platform.granted = false
    await expect(service.saveConfig(userpassConfig)).rejects.toMatchObject({ kind: 'host_permission' })
    await expect(service.probe(ADDRESS)).rejects.toMatchObject({ kind: 'host_permission' })
  })

  test('getConfig mirrors what was saved, null when absent', async () => {
    const { service } = setup()
    expect(await service.getConfig()).toBeNull()
    await service.saveConfig(userpassConfig)
    expect(await service.getConfig()).toMatchObject({ address: ADDRESS, auth: { method: 'userpass' } })
  })

  test('saves and schedules the refresh', async () => {
    const { service, platform } = setup()
    const status = await service.saveConfig(userpassConfig)
    expect(status).toMatchObject({ configured: true, address: ADDRESS, unlocked: false })
    expect(platform.alarmTable.get(ALARMS.refresh)).toEqual({ periodInMinutes: 15 })
  })

  test('probe', async () => {
    const { service } = setup()
    expect(await service.probe(`${ADDRESS}/`)).toMatchObject({ sealed: false, version: '2.6.2' })
  })

  test('changing timing keeps session and index', async () => {
    const { service, platform } = await unlocked()
    await service.saveConfig({ ...userpassConfig, lockAfterMinutes: 20 })
    const status = await service.status()
    expect(status.unlocked).toBe(true)
    expect(status.index.count).toBe(5)
    expect(platform.alarmTable.get(ALARMS.idle)).toEqual({ when: platform.clock + 20 * 60_000 })
  })

  test('changing mounts drops the index only', async () => {
    const { service } = await unlocked()
    await service.saveConfig({ ...userpassConfig, mounts: { mode: 'manual', paths: ['secret'] } })
    const status = await service.status()
    expect(status.unlocked).toBe(true)
    expect(status.index.count).toBe(0)
  })

  test('changing the server locks and revokes', async () => {
    const { service, calls } = await unlocked()
    await service.saveConfig({ ...userpassConfig, namespace: 'other' })
    expect((await service.status()).unlocked).toBe(false)
    expect(calls.at(-1)?.path).toBe('auth/token/revoke-self')
  })

  test('an unreadable stored config counts as absent', async () => {
    const { service, platform } = setup()
    platform.localData.set(KEYS.config, { address: 'nope' })
    expect((await service.status()).configured).toBe(false)
  })
})

describe('login', () => {
  test('needs a config, the permission and the configured method', async () => {
    const { service, platform } = setup()
    await expect(service.login({ method: 'token', token: 't' })).rejects.toMatchObject({ kind: 'not_configured' })
    await service.saveConfig(userpassConfig)
    await expect(service.login({ method: 'token', token: 't' })).rejects.toMatchObject({ kind: 'bad_request' })
    platform.granted = false
    await expect(service.login({ method: 'userpass', password: 'p' })).rejects.toMatchObject({
      kind: 'host_permission',
    })
  })

  test('userpass: token in session storage only, alarms set, index built', async () => {
    const { service, platform } = setup()
    await service.saveConfig(userpassConfig)
    const status = await service.login({ method: 'userpass', password: 'pw' })

    expect(status).toMatchObject({
      unlocked: true,
      method: 'userpass',
      expiresAt: platform.clock + 3_600_000,
      lockAt: platform.clock + 600_000,
    })
    expect(JSON.stringify(platform.sessionData.get(KEYS.session))).toContain('s.user')
    expect([...platform.alarmTable.keys()].sort()).toEqual([
      ALARMS.expire,
      ALARMS.idle,
      ALARMS.refresh,
      ALARMS.renew,
    ])
    expect(platform.alarmTable.get(ALARMS.renew)).toEqual({ when: platform.clock + 2_400_000 })

    const index = await service.refreshIndex()
    expect(index.entries).toHaveLength(5)
    expect(index.identity).toBe('ent-julien')

    const local = JSON.stringify([...platform.localData.values()])
    expect(local).not.toContain('s.user')
    expect(local).not.toContain('-pass')
  })

  test('other methods', async () => {
    const { service, calls } = setup()

    await service.saveConfig({ address: ADDRESS, auth: { method: 'token' } })
    expect(await service.login({ method: 'token', token: 'root' })).toMatchObject({ method: 'token' })

    await service.saveConfig({ address: ADDRESS, auth: { method: 'ldap', username: 'julien' } })
    expect(await service.login({ method: 'ldap', password: 'p' })).toMatchObject({ method: 'ldap' })

    await service.saveConfig({ address: ADDRESS, auth: { method: 'approle', roleId: 'r' } })
    expect(await service.login({ method: 'approle', secretId: 's' })).toMatchObject({ method: 'approle' })
    expect(calls.find((c) => c.path === 'auth/approle/login')?.body).toEqual({ role_id: 'r', secret_id: 's' })
  })

  test('oidc drives the browser window', async () => {
    const { service, platform, calls } = setup({
      'POST auth/sso/oidc/auth_url': { body: { data: { auth_url: 'https://idp/auth?state=st' } } },
      'GET auth/sso/oidc/callback': authReply('s.oidc'),
    })
    platform.authFlow = async (url) => {
      expect(url).toBe('https://idp/auth?state=st')
      return 'https://ext-id.chromiumapp.org/oidc?code=c&state=st'
    }
    await service.saveConfig({ address: ADDRESS, auth: { method: 'oidc', mount: 'sso', role: 'vcf' } })
    expect(await service.login({ method: 'oidc' })).toMatchObject({ method: 'oidc', unlocked: true })
    expect(calls[0]?.body).toMatchObject({ role: 'vcf', redirect_uri: 'https://ext-id.chromiumapp.org/oidc' })

    await service.saveConfig({ address: ADDRESS, auth: { method: 'oidc' } })
    await expect(service.login({ method: 'oidc' })).rejects.toBeDefined()
  })

  test('mismatched input is refused', async () => {
    const { service } = setup()
    await service.saveConfig({ address: ADDRESS, auth: { method: 'ldap', username: 'j' } })
    // Bypasses the equality check the router would do on a real message.
    const forged = { method: 'ldap' as const, password: 'p' }
    await service.saveConfig({ address: ADDRESS, auth: { method: 'userpass', username: 'j' } })
    await expect(service.login(forged)).rejects.toMatchObject({ kind: 'bad_request' })
  })

  test('another identity invalidates the index', async () => {
    const { service, platform } = await unlocked({
      'POST auth/userpass/login/julien': authReply('s.user', { entity_id: 'ent-julien' }),
    })
    const index = platform.localData.get(KEYS.index) as StoredIndex
    platform.localData.set(KEYS.index, { ...index, identity: 'someone-else' })
    await service.lock('user')
    await service.login({ method: 'userpass', password: 'pw' })
    const rebuilt = await service.refreshIndex()
    expect(rebuilt.identity).toBe('ent-julien')
  })

  test('logout revokes and drops everything', async () => {
    const { service, platform, calls } = await unlocked()
    await service.logout()
    expect(calls.at(-1)?.path).toBe('auth/token/revoke-self')
    expect(platform.sessionData.size).toBe(0)
    expect(platform.localData.has(KEYS.index)).toBe(false)
    expect([...platform.alarmTable.keys()]).toEqual([ALARMS.refresh])
  })

  test('an expired stored session is dropped without revoking', async () => {
    const { service, platform, calls } = await unlocked()
    platform.clock += 3_600_000
    const before = calls.length
    expect((await service.status()).unlocked).toBe(false)
    expect(platform.sessionData.size).toBe(0)
    expect(calls.length).toBe(before)
  })
})

describe('index', () => {
  test('refresh requires a session and dedupes', async () => {
    const { service } = setup()
    await service.saveConfig(userpassConfig)
    await expect(service.refreshIndex()).rejects.toMatchObject({ kind: 'locked' })

    await service.login({ method: 'userpass', password: 'pw' })
    const a = service.refreshIndex()
    const b = service.refreshIndex()
    expect(a).toBe(b)
    expect((await service.status()).index.refreshing).toBe(true)
    await a
    expect((await service.status()).index).toMatchObject({ refreshing: false, count: 5, stale: false })
  })

  test('manual mounts', async () => {
    const { service, calls } = setup()
    await service.saveConfig({ ...userpassConfig, mounts: { mode: 'manual', paths: ['secret'] } })
    await service.login({ method: 'userpass', password: 'pw' })
    const index = await service.refreshIndex()
    expect(index.entries).toHaveLength(5)
    expect(calls.some((c) => c.path === 'sys/internal/ui/mounts')).toBe(false)
  })

  test('problems are stored as kinds only', async () => {
    const { service } = await unlocked({ 'GET secret/metadata/grafana': denied })
    const index = await service.refreshIndex()
    expect(index.problems).toEqual([{ mount: 'secret', path: 'grafana', kind: 'permission' }])
    expect((await service.status()).index.problems).toBe(1)
  })

  test('a failed refresh keeps the previous index', async () => {
    let broken = false
    const { service, platform } = await unlocked({
      'LIST secret/metadata/': () => (broken ? { status: 500, body: { errors: ['boom'] } } : listReply(['gitlab'])),
    })
    broken = true
    platform.clock += 60_000
    await expect(service.refreshIndex()).rejects.toMatchObject({ kind: 'server' })
    const status = await service.status()
    expect(status.index.count).toBe(1)
    expect(status.index.lastError).toEqual({ at: platform.clock, kind: 'server', message: 'boom' })
  })

  test('a first failed refresh stores nothing', async () => {
    const { service, platform } = setup({ 'GET sys/internal/ui/mounts': { status: 500 } })
    await service.saveConfig(userpassConfig)
    await service.login({ method: 'userpass', password: 'pw' })
    await expect(service.refreshIndex()).rejects.toMatchObject({ kind: 'server' })
    expect(platform.localData.has(KEYS.index)).toBe(false)
  })

  test('a policy denial during refresh keeps the session', async () => {
    let denying = false
    const { service } = await unlocked({
      'GET sys/internal/ui/mounts': () => (denying ? denied : { body: { data: { secret: {} } } }),
    })
    denying = true
    await expect(service.refreshIndex()).rejects.toMatchObject({ kind: 'permission' })
    expect((await service.status()).unlocked).toBe(true)
  })

  test('a dead token during refresh locks', async () => {
    let dead = false
    const { service } = await unlocked({
      'GET sys/internal/ui/mounts': () => (dead ? denied : { body: { data: { secret: {} } } }),
      'GET auth/token/lookup-self': () => (dead ? denied : { body: { data: {} } }),
    })
    dead = true
    await expect(service.refreshIndex()).rejects.toMatchObject({ kind: 'permission' })
    expect((await service.status()).unlocked).toBe(false)
  })

  test('index becomes stale after two refresh periods', async () => {
    const { service, platform } = await unlocked()
    platform.clock += 31 * 60_000
    expect((await service.status()).index.stale).toBe(true)
  })

  test('keeps the worker alive during long builds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, platform } = setup()
    const slowFetch = platform.fetch!
    ;(platform as { fetch?: typeof slowFetch }).fetch = async (input, init) => {
      if (input.includes('/metadata/?')) await gate
      return slowFetch(input, init)
    }
    await service.saveConfig(userpassConfig)
    await service.login({ method: 'userpass', password: 'pw' })
    const pending = service.refreshIndex()
    await vi.waitFor(() => expect(service['refreshing']).not.toBeNull())
    await new Promise((r) => setTimeout(r, 10))
    vi.advanceTimersByTime(45_000)
    release()
    await pending
    expect(platform.keepAlives).toBe(2)
  })
})

describe('matches', () => {
  test('lists candidates even while locked, never for other schemes', async () => {
    const { service } = await unlocked()
    await service.lock('user')
    const result = await service.matches('https://gitlab.example.net/', false)
    expect(result.unlocked).toBe(false)
    expect(result.candidates.map((c) => c.title)).toEqual(['GitLab', 'grafana', 'mail'])
    expect((await service.matches('file:///etc/passwd', true)).candidates).toEqual([])
    expect((await service.matches('not a url', true)).candidates).toEqual([])
  })

  test('flags downgrades', async () => {
    const { service } = await unlocked()
    const [legacy] = (await service.matches('http://legacy.example.org/', false)).candidates
    expect(legacy).toMatchObject({ title: 'Legacy', downgrade: true })
    const [plain] = (await service.matches('http://intranet.example.com/', false)).candidates
    expect(plain).toMatchObject({ path: 'plain', downgrade: false })
  })

  test('only user actions keep the session alive', async () => {
    const { service, platform } = await unlocked()
    const lockAt = (await service.status()).lockAt!
    platform.clock += 60_000
    await service.matches('https://gitlab.example.net/', false)
    expect((await service.status()).lockAt).toBe(lockAt)
    await service.matches('https://gitlab.example.net/', true)
    expect((await service.status()).lockAt).toBe(lockAt + 60_000)
    // Throttled.
    platform.clock += 1_000
    await service.matches('https://gitlab.example.net/', true)
    expect((await service.status()).lockAt).toBe(lockAt + 60_000)
  })

  test('no config, no candidates', async () => {
    const { service } = setup()
    expect(await service.matches('https://gitlab.example.net/', true)).toEqual({ unlocked: false, candidates: [] })
  })
})

describe('fill', () => {
  test('delivers the credential to the frame, nothing else', async () => {
    const { service, platform } = await unlocked()
    expect(await service.fill(fillRequest({ frameId: 3 }))).toEqual({ username: true, password: true, totp: false })
    expect(platform.delivered).toEqual([
      { tabId: 7, frameId: 3, payload: { type: 'vcf/fill', username: 'julien', password: 'gitlab-pass', totp: null } },
    ])
    const stored = JSON.stringify([...platform.localData.values(), ...platform.sessionData.values()])
    expect(stored).not.toContain('gitlab-pass')
  })

  test('computes TOTP codes instead of sending the seed', async () => {
    const { service, platform } = await unlocked()
    platform.clock = 59_000
    // Session was observed at 1_000_000, so move the lease with the clock.
    const state = platform.sessionData.get(KEYS.session) as { session: { observedAt: number } }
    state.session.observedAt = 0
    const result = await service.fill(fillRequest({ frameUrl: 'https://mail.example.net/', path: 'mail' }))
    expect(result).toEqual({ username: true, password: true, totp: true })
    // RFC 6238 SHA-1 vector, 6 digits.
    expect(platform.delivered[0]?.payload.totp).toBe('287082')
    expect(JSON.stringify(platform.delivered)).not.toContain('GEZDGNBV')
  })

  test('an unparseable seed fills without a code', async () => {
    const { service, platform } = await unlocked({
      'GET secret/data/mail': data({ email: 'j', password: 'p', totp: 'not base32!' }),
    })
    const result = await service.fill(fillRequest({ frameUrl: 'https://mail.example.net/', path: 'mail' }))
    expect(result.totp).toBe(false)
    expect(platform.delivered[0]?.payload.totp).toBeNull()
  })

  test('refuses credentials that do not belong to the page', async () => {
    const { service, platform } = await unlocked()
    await expect(service.fill(fillRequest({ frameUrl: 'https://evil.example.com/' }))).rejects.toMatchObject({
      kind: 'no_match',
    })
    await expect(service.fill(fillRequest({ path: 'unknown' }))).rejects.toMatchObject({ kind: 'no_match' })
    await expect(service.fill(fillRequest({ frameUrl: 'chrome://settings' }))).rejects.toMatchObject({
      kind: 'unsupported_page',
    })
    expect(platform.delivered).toEqual([])
  })

  test('downgrade needs confirmation', async () => {
    const { service, platform } = await unlocked()
    const request = fillRequest({ frameUrl: 'http://legacy.example.org/login', path: 'legacy-site' })
    await expect(service.fill(request)).rejects.toMatchObject({ kind: 'downgrade' })
    expect(platform.delivered).toEqual([])
    await expect(service.fill({ ...request, allowDowngrade: true })).resolves.toMatchObject({ password: true })
  })

  test('locked or unconfigured', async () => {
    const { service } = setup()
    await expect(service.fill(fillRequest())).rejects.toMatchObject({ kind: 'not_configured' })
    const ready = await unlocked()
    await ready.service.lock('user')
    await expect(ready.service.fill(fillRequest())).rejects.toMatchObject({ kind: 'locked' })
  })

  test('policy denial keeps the session, dead token locks', async () => {
    let dead = false
    const { service } = await unlocked({
      'GET auth/token/lookup-self': () =>
        dead ? denied : { body: { data: { accessor: 'a', policies: [], ttl: 1, renewable: false } } },
    })
    const grafana = fillRequest({ frameUrl: 'https://grafana.example.net/', path: 'grafana' })
    await expect(service.fill(grafana)).rejects.toMatchObject({ kind: 'permission' })
    expect((await service.status()).unlocked).toBe(true)

    dead = true
    await expect(service.fill(grafana)).rejects.toMatchObject({ kind: 'permission' })
    expect((await service.status()).unlocked).toBe(false)
  })

  test('other read errors pass through', async () => {
    const { service } = await unlocked({ 'GET secret/data/gitlab': { status: 503, body: { errors: ['sealed'] } } })
    await expect(service.fill(fillRequest())).rejects.toMatchObject({ kind: 'sealed' })
  })

  test('no content script in the frame', async () => {
    const { service, platform } = await unlocked()
    platform.receiverMissing = true
    await expect(service.fill(fillRequest())).rejects.toMatchObject({ kind: 'no_receiver' })
  })
})

describe('alarms', () => {
  test('renewal reschedules while the lease grows', async () => {
    const { service, platform } = await unlocked()
    platform.clock += 2_400_000
    await service.onAlarm(ALARMS.renew)
    expect(platform.alarmTable.get(ALARMS.renew)).toEqual({ when: platform.clock + 2_400_000 })
    expect(platform.alarmTable.get(ALARMS.expire)).toEqual({ when: platform.clock + 3_600_000 })
  })

  test('renewal stops at max TTL', async () => {
    const { service, platform } = await unlocked({
      'POST auth/token/renew-self': authReply('s.user', { lease_duration: 1200 }),
    })
    platform.clock += 2_400_000
    await service.onAlarm(ALARMS.renew)
    expect(platform.alarmTable.has(ALARMS.renew)).toBe(false)
    expect(platform.alarmTable.get(ALARMS.expire)).toEqual({ when: platform.clock + 1_200_000 })
  })

  test('renewal of a dead token locks', async () => {
    const { service, platform } = await unlocked({ 'POST auth/token/renew-self': denied })
    await service.onAlarm(ALARMS.renew)
    expect(platform.sessionData.size).toBe(0)
  })

  test('transient renewal failure retries before expiry only', async () => {
    const { service, platform } = await unlocked({ 'POST auth/token/renew-self': { status: 502 } })
    platform.alarmTable.delete(ALARMS.renew)
    await service.onAlarm(ALARMS.renew)
    expect(platform.alarmTable.get(ALARMS.renew)).toEqual({ when: platform.clock + 60_000 })

    platform.alarmTable.delete(ALARMS.renew)
    platform.clock += 3_599_000
    await service.onAlarm(ALARMS.renew)
    expect(platform.alarmTable.has(ALARMS.renew)).toBe(false)
  })

  test('renewal without session or config is a no-op', async () => {
    const { service, calls } = setup()
    await service.onAlarm(ALARMS.renew)
    await service.onAlarm('unknown')
    expect(calls).toEqual([])
  })

  test('non-expiring token retries renewal forever', async () => {
    const { service, platform } = setup({
      'GET auth/token/lookup-self': {
        body: { data: { accessor: 'a', policies: ['root'], ttl: 0, renewable: false } },
      },
      'POST auth/token/renew-self': { status: 400 },
    })
    await service.saveConfig({ address: ADDRESS, auth: { method: 'token' } })
    await service.login({ method: 'token', token: 'root' })
    expect(platform.alarmTable.has(ALARMS.renew)).toBe(false)
    expect(platform.alarmTable.has(ALARMS.expire)).toBe(false)
    await service.onAlarm(ALARMS.renew)
    expect(platform.alarmTable.get(ALARMS.renew)).toEqual({ when: platform.clock + 60_000 })
  })

  test('expiry', async () => {
    const { service, platform } = await unlocked()
    await service.onAlarm(ALARMS.expire)
    expect(platform.sessionData.size).toBe(1)
    expect(platform.alarmTable.get(ALARMS.expire)).toEqual({ when: platform.clock + 3_600_000 })

    platform.clock += 3_600_000
    await service.onAlarm(ALARMS.expire)
    expect(platform.sessionData.size).toBe(0)
    await service.onAlarm(ALARMS.expire)
  })

  test('idle lock revokes the token', async () => {
    const { service, platform, calls } = await unlocked()
    platform.clock += 5 * 60_000
    await service.onAlarm(ALARMS.idle)
    expect(platform.sessionData.size).toBe(1)
    expect(platform.alarmTable.get(ALARMS.idle)).toEqual({ when: platform.clock + 5 * 60_000 })

    platform.clock += 5 * 60_000
    await service.onAlarm(ALARMS.idle)
    expect(platform.sessionData.size).toBe(0)
    expect(calls.at(-1)?.path).toBe('auth/token/revoke-self')

    await service.onAlarm(ALARMS.idle)
  })

  test('lock survives a failing revoke', async () => {
    const { service, platform } = await unlocked({ 'POST auth/token/revoke-self': { status: 500 } })
    await service.lock('idle')
    expect(platform.sessionData.size).toBe(0)
    await service.lock('idle')
  })

  test('periodic refresh only when unlocked, errors swallowed', async () => {
    let failing = false
    const { service, platform, calls } = await unlocked({
      'LIST secret/metadata/': () => (failing ? { status: 500 } : listReply(['gitlab'])),
    })
    const lists = () => calls.filter((c) => c.method === 'LIST').length
    const before = lists()
    await service.onAlarm(ALARMS.refresh)
    expect(lists()).toBe(before + 1)

    failing = true
    await expect(service.onAlarm(ALARMS.refresh)).resolves.toBeUndefined()

    await service.lock('user')
    await service.onAlarm(ALARMS.refresh)
    expect(lists()).toBe(before + 2)
    expect(platform.sessionData.size).toBe(0)
  })
})

describe('reconcile', () => {
  test('clears everything without a config', async () => {
    const { service, platform } = setup()
    platform.alarmTable.set(ALARMS.renew, { when: 1 })
    platform.alarmTable.set(ALARMS.refresh, { periodInMinutes: 1 })
    await service.reconcile()
    expect(platform.alarmTable.size).toBe(0)
  })

  test('keeps only the refresh while locked', async () => {
    const { service, platform } = await unlocked()
    await service.lock('user')
    platform.alarmTable.set(ALARMS.idle, { when: 1 })
    await service.reconcile()
    expect([...platform.alarmTable.keys()]).toEqual([ALARMS.refresh])
  })

  test('restores session alarms', async () => {
    const { service, platform } = await unlocked()
    platform.alarmTable.clear()
    await service.reconcile()
    expect([...platform.alarmTable.keys()].sort()).toEqual([
      ALARMS.expire,
      ALARMS.idle,
      ALARMS.refresh,
      ALARMS.renew,
    ])
  })
})

test('isDowngrade', () => {
  expect(isDowngrade('http', 'https')).toBe(true)
  expect(isDowngrade('http', undefined)).toBe(true)
  expect(isDowngrade('http', 'http')).toBe(false)
  expect(isDowngrade('https', undefined)).toBe(false)
})
