/**
 * The service worker logic against real servers, with the browser
 * replaced by the in-memory platform used in unit tests.
 */
import { describe, expect, test } from 'vitest'
import { ALARMS, BackgroundService } from '../../src/background/service'
import { KEYS } from '../../src/background/stores'
import { fakePlatform } from '../../src/background/fake-platform.test-helper'
import type { FetchLike } from '../../src/vault/http'

const targets = (process.env.VCF_TARGETS ?? 'vault=http://127.0.0.1:8200,openbao=http://127.0.0.1:8300')
  .split(',')
  .map((pair) => pair.split('=') as [string, string])

const realFetch: FetchLike = (input, init) => fetch(input, init)

describe.each(targets)('%s', (_name, address) => {
  async function unlocked(auth: object, input: Parameters<BackgroundService['login']>[0]) {
    const platform = fakePlatform(realFetch)
    platform.clock = Date.now()
    const service = new BackgroundService(platform)
    await service.saveConfig({ address, auth })
    await service.login(input)
    await service.refreshIndex()
    return { platform, service }
  }

  test('userpass: unlock, index, match, fill, lock', async () => {
    const { platform, service } = await unlocked(
      { method: 'userpass', username: 'vcf' },
      { method: 'userpass', password: 'vcf' },
    )

    const status = await service.status()
    expect(status).toMatchObject({ unlocked: true, method: 'userpass' })
    expect(status.index.count).toBe(12)

    const { candidates } = await service.matches('https://mail.example.net/login', true)
    expect(candidates[0]).toMatchObject({ path: 'perso/mail', downgrade: false })

    const result = await service.fill({
      tabId: 1,
      frameId: 0,
      frameUrl: 'https://mail.example.net/login',
      mount: 'secret',
      path: 'perso/mail',
      allowDowngrade: false,
    })
    expect(result).toEqual({ username: true, password: true, totp: true })
    expect(platform.delivered[0]?.payload).toMatchObject({
      username: 'julien@example.net',
      password: 'mail-pass',
      totp: expect.stringMatching(/^\d{6}$/),
    })

    const token = (platform.sessionData.get(KEYS.session) as { session: { token: string } }).session.token
    const local = JSON.stringify([...platform.localData.values()])
    expect(local).not.toContain('mail-pass')
    expect(local).not.toContain(token)

    await service.onAlarm(ALARMS.renew)
    expect((await service.status()).unlocked).toBe(true)

    await service.lock('idle')
    const lookup = await fetch(`${address}/v1/auth/token/lookup-self`, { headers: { 'X-Vault-Token': token } })
    expect(lookup.status).toBe(403)
  })

  test('policy denial on fill keeps the session', async () => {
    const { service } = await unlocked({ method: 'token' }, { method: 'token', token: 'vcf-token' })
    await expect(
      service.fill({
        tabId: 1,
        frameId: 0,
        frameUrl: 'https://grafana.example.net/',
        mount: 'secret',
        path: 'pro/grafana',
        allowDowngrade: false,
      }),
    ).rejects.toMatchObject({ kind: 'permission' })
    expect((await service.status()).unlocked).toBe(true)
  })

  test('approle with manual mounts', async () => {
    const platform = fakePlatform(realFetch)
    platform.clock = Date.now()
    const service = new BackgroundService(platform)
    await service.saveConfig({
      address,
      auth: { method: 'approle', roleId: 'vcf-role' },
      mounts: { mode: 'manual', paths: ['team'] },
    })
    await service.login({ method: 'approle', secretId: 'vcf-secret' })
    const index = await service.refreshIndex()
    expect(index.entries.map((e) => e.path)).toEqual(['shared/wiki'])
    await service.logout()
  })
})
