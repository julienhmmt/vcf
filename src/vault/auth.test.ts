import { describe, expect, test } from 'vitest'
import { VaultHttp } from './http'
import {
  loginApprole,
  loginToken,
  loginUserpass,
  renewSelf,
  revokeSelf,
  sessionFromAuth,
  trimMount,
} from './auth'
import { authReply, denied, fakeVault } from './fake-server.test-helper'
import type { FakeReply } from './fake-server.test-helper'

const now = () => 42

function ctx(routes: Record<string, FakeReply>) {
  const { fetch, calls } = fakeVault(routes)
  return { ctx: { http: new VaultHttp({ address: 'http://v', fetch }), now }, calls }
}

describe('loginUserpass', () => {
  test('posts the password to the user path', async () => {
    const { ctx: c, calls } = ctx({ 'POST auth/userpass/login/julien': authReply('s.abc') })

    const session = await loginUserpass(c, { username: 'julien', password: 'pw' })

    expect(calls[0]?.body).toEqual({ password: 'pw' })
    expect(session).toEqual({
      token: 's.abc',
      accessor: 'acc-s.abc',
      policies: ['default', 'vcf-filler'],
      ttl: 3600,
      renewable: true,
      observedAt: 42,
      entityId: 'ent-1',
      method: 'userpass',
    })
  })

  test('custom mount, ldap flavour', async () => {
    const { ctx: c } = ctx({ 'POST auth/corp-ldap/login/j': authReply('t', { entity_id: '' }) })
    const session = await loginUserpass(c, { username: 'j', password: 'p', mount: '/corp-ldap/' }, 'ldap')
    expect(session.method).toBe('ldap')
    expect(session).not.toHaveProperty('entityId')
  })

  test('rejects bad input before any request', async () => {
    const { ctx: c, calls } = ctx({})
    await expect(loginUserpass(c, { username: ' ', password: 'p' })).rejects.toMatchObject({ kind: 'invalid' })
    await expect(loginUserpass(c, { username: 'a/b', password: 'p' })).rejects.toMatchObject({ kind: 'invalid' })
    expect(calls).toHaveLength(0)
  })

  test('bad credentials surface as invalid', async () => {
    const { ctx: c } = ctx({
      'POST auth/userpass/login/j': { status: 400, body: { errors: ['invalid username or password'] } },
    })
    await expect(loginUserpass(c, { username: 'j', password: 'x' })).rejects.toMatchObject({
      kind: 'invalid',
      message: 'invalid username or password',
    })
  })
})

describe('loginApprole', () => {
  test('sends role and secret id', async () => {
    const { ctx: c, calls } = ctx({ 'POST auth/approle/login': authReply('t', { policies: null, token_policies: null }) })
    const session = await loginApprole(c, { roleId: 'r', secretId: 's' })
    expect(calls[0]?.body).toEqual({ role_id: 'r', secret_id: 's' })
    expect(session.policies).toEqual([])
    expect(session.method).toBe('approle')
  })

  test('omits an empty secret id (bind_secret_id=false roles)', async () => {
    const { ctx: c, calls } = ctx({ 'POST auth/ar/login': authReply('t') })
    await loginApprole(c, { roleId: 'r', secretId: '', mount: 'ar' })
    expect(calls[0]?.body).toEqual({ role_id: 'r' })
  })

  test('requires a role id', async () => {
    const { ctx: c } = ctx({})
    await expect(loginApprole(c, { roleId: '' })).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('loginToken', () => {
  const lookup = {
    body: {
      data: { accessor: 'a', policies: ['root'], ttl: 0, renewable: false, entity_id: '' },
    },
  }

  test('validates through lookup-self', async () => {
    const { ctx: c, calls } = ctx({ 'GET auth/token/lookup-self': lookup })
    const session = await loginToken(c, 'root')
    expect(calls[0]?.headers['X-Vault-Token']).toBe('root')
    expect(session).toEqual({
      token: 'root',
      accessor: 'a',
      policies: ['root'],
      ttl: 0,
      renewable: false,
      observedAt: 42,
      method: 'token',
    })
  })

  test('keeps entity id and tolerates null policies', async () => {
    const { ctx: c } = ctx({
      'GET auth/token/lookup-self': {
        body: { data: { accessor: 'a', policies: null, ttl: 5, renewable: true, entity_id: 'e' } },
      },
    })
    await expect(loginToken(c, 't')).resolves.toMatchObject({ policies: [], entityId: 'e' })
  })

  test('403 means the token is dead', async () => {
    const { ctx: c } = ctx({ 'GET auth/token/lookup-self': denied })
    await expect(loginToken(c, 'bad')).rejects.toMatchObject({ kind: 'unauthenticated', status: 403 })
  })

  test('other errors pass through', async () => {
    const { ctx: c } = ctx({ 'GET auth/token/lookup-self': { status: 503, body: { errors: ['sealed'] } } })
    await expect(loginToken(c, 't')).rejects.toMatchObject({ kind: 'sealed' })
  })

  test('empty data is a protocol error', async () => {
    const { ctx: c } = ctx({ 'GET auth/token/lookup-self': { body: { data: null } } })
    await expect(loginToken(c, 't')).rejects.toMatchObject({ kind: 'protocol' })
  })

  test('empty token', async () => {
    const { ctx: c } = ctx({})
    await expect(loginToken(c, '')).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('renew and revoke', () => {
  const session = {
    token: 't',
    accessor: 'a',
    policies: [],
    ttl: 10,
    renewable: true,
    observedAt: 0,
    method: 'approle' as const,
  }

  test('renew sends no increment and keeps method and token', async () => {
    const { ctx: c, calls } = ctx({ 'POST auth/token/renew-self': authReply('other', { lease_duration: 7200 }) })
    const renewed = await renewSelf(c, session)
    expect(calls[0]?.body).toEqual({})
    expect(renewed).toMatchObject({ token: 't', method: 'approle', ttl: 7200, observedAt: 42 })
  })

  test('renew of a dead token', async () => {
    const { ctx: c } = ctx({ 'POST auth/token/renew-self': denied })
    await expect(renewSelf(c, session)).rejects.toMatchObject({ kind: 'unauthenticated' })
  })

  test('revoke is quiet about already-dead tokens', async () => {
    const { ctx: c } = ctx({ 'POST auth/token/revoke-self': denied })
    await expect(revokeSelf(c, 't')).resolves.toBeUndefined()
  })

  test('revoke surfaces other failures', async () => {
    const { ctx: c } = ctx({ 'POST auth/token/revoke-self': { status: 500 } })
    await expect(revokeSelf(c, 't')).rejects.toMatchObject({ kind: 'server' })
  })

  test('revoke success, default clock', async () => {
    const { fetch } = fakeVault({ 'POST auth/token/revoke-self': { status: 204 } })
    await expect(revokeSelf({ http: new VaultHttp({ address: 'http://v', fetch }) }, 't')).resolves.toBeUndefined()
  })
})

test('sessionFromAuth requires a token', () => {
  expect(() => sessionFromAuth(null, 'token', 0)).toThrow('no token')
})

test('trimMount', () => {
  expect(trimMount(' /a/b/ ')).toBe('a/b')
  expect(() => trimMount('//')).toThrow('empty')
})
