import { describe, expect, test } from 'vitest'
import { VaultClient } from './client'
import { authReply, denied, fakeVault, listReply } from './fake-server.test-helper'
import type { Session } from './auth'

const lookup = {
  body: { data: { accessor: 'a', policies: ['vcf-filler'], ttl: 3600, renewable: true } },
}

function server() {
  return fakeVault({
    'GET auth/token/lookup-self': lookup,
    'POST auth/userpass/login/j': authReply('s.up'),
    'POST auth/ldap/login/j': authReply('s.ldap'),
    'POST auth/approle/login': authReply('s.ar'),
    'POST auth/token/renew-self': authReply('s.up', { lease_duration: 7200 }),
    'POST auth/token/revoke-self': { status: 204 },
    'GET sys/internal/ui/mounts': {
      body: {
        data: {
          secret: {
            'secret/': { type: 'kv', options: { version: '2' } },
            'legacy/': { type: 'kv', options: { version: '1' } },
          },
        },
      },
    },
    'GET sys/internal/ui/mounts/team': {
      body: { data: { type: 'kv', path: 'team/', options: { version: '2' } } },
    },
    'GET sys/internal/ui/resultant-acl': {
      body: {
        data: {
          glob_paths: {
            'secret/metadata/': { capabilities: ['list', 'read'] },
            'legacy/': { capabilities: ['list', 'read'] },
          },
        },
      },
    },
    'LIST secret/metadata/': listReply(['gitlab', 'pro/']),
    'LIST secret/metadata/pro/': listReply(['grafana']),
    'GET secret/metadata/gitlab': { body: { data: { custom_metadata: { url: 'https://gitlab.example.net' } } } },
    'GET secret/metadata/pro/grafana': { body: { data: { custom_metadata: { url: 'https://grafana.example.net' } } } },
    'LIST legacy/': listReply(['example.org']),
    'GET secret/data/gitlab': { body: { data: { data: { username: 'julien', password: 'pw' } } } },
    'GET secret/data/pro/grafana': denied,
    'GET team/data/wiki': { body: { data: { data: { user: 'team', password: 'w' } } } },
  })
}

describe('VaultClient', () => {
  test('health reads the unwrapped body', async () => {
    const { fetch, calls } = fakeVault({
      'GET sys/health': { body: { initialized: true, sealed: false, standby: false, version: '2.6.2' } },
    })
    const health = await new VaultClient({ address: 'http://v', fetch }).health()
    expect(health).toEqual({ initialized: true, sealed: false, standby: false, version: '2.6.2' })
    expect(calls[0]?.query.get('sealedcode')).toBe('200')
  })

  test('health defaults for an empty body', async () => {
    const { fetch } = fakeVault({ 'GET sys/health': { status: 204 } })
    const health = await new VaultClient({ address: 'http://v', fetch }).health({
      signal: new AbortController().signal,
    })
    expect(health).toEqual({ initialized: false, sealed: true, standby: false, version: '' })
  })

  test('every login method yields a session client', async () => {
    const { fetch } = server()
    const vault = new VaultClient({ address: 'http://v', fetch, now: () => 7 })

    expect((await vault.withToken('root')).session).toMatchObject({ method: 'token', observedAt: 7 })
    expect((await vault.withUserpass({ username: 'j', password: 'p' })).session.token).toBe('s.up')
    expect((await vault.withLdap({ username: 'j', password: 'p' })).session).toMatchObject({
      token: 's.ldap',
      method: 'ldap',
    })
    expect((await vault.withApprole({ roleId: 'r', secretId: 's' })).session.token).toBe('s.ar')
  })

  test('oidc through the facade', async () => {
    const { fetch } = fakeVault({
      'POST auth/oidc/oidc/auth_url': { body: { data: { auth_url: 'https://idp/a?state=s' } } },
      'GET auth/oidc/oidc/callback': authReply('s.o'),
    })
    const vault = new VaultClient({ address: 'http://v', fetch })
    const client = await vault.withOidc({
      redirectUri: 'https://x.chromiumapp.org/cb',
      openAuthWindow: async () => 'https://x.chromiumapp.org/cb?code=c&state=s',
    })
    expect(client.session.method).toBe('oidc')
  })
})

describe('SessionClient', () => {
  async function session() {
    const { fetch, calls } = server()
    const vault = new VaultClient({ address: 'http://v', fetch })
    return { client: await vault.withUserpass({ username: 'j', password: 'p' }), calls }
  }

  test('verify, renew, logout', async () => {
    const { client, calls } = await session()
    await client.verify()
    const renewed = await client.renew()
    expect(renewed.ttl).toBe(7200)
    expect(client.session).toBe(renewed)
    await client.logout()
    expect(calls.map((c) => `${c.method} ${c.path}`).slice(1)).toEqual([
      'GET auth/token/lookup-self',
      'POST auth/token/renew-self',
      'POST auth/token/revoke-self',
    ])
  })

  test('discovers mounts and indexes them all', async () => {
    const { client } = await session()
    const mounts = await client.kvMounts()
    expect(mounts.map((m) => m.path)).toEqual(['legacy', 'secret'])

    const index = await client.buildIndex(mounts)
    expect(index.entries.map((e) => `${e.mount}:${e.path}`)).toEqual([
      'legacy:example.org',
      'secret:gitlab',
      'secret:pro/grafana',
    ])
    expect(index.scanned).toBe(3)
    expect(index.problems).toEqual([])
  })

  test('starts scoped walks where the ACL allows', async () => {
    const { fetch, calls } = fakeVault({
      'POST auth/userpass/login/s': authReply('s.s'),
      'GET sys/internal/ui/resultant-acl': {
        body: { data: { glob_paths: { 'secret/metadata/perso/': { capabilities: ['list'] } } } },
      },
      'LIST secret/metadata/perso/': listReply(['github.com']),
      'GET secret/metadata/perso/github.com': { body: { data: { custom_metadata: null } } },
    })
    const client = await new VaultClient({ address: 'http://v', fetch }).withUserpass({ username: 's', password: 'p' })
    const index = await client.buildIndex([{ path: 'secret', version: 2, description: '' }], {
      signal: new AbortController().signal,
    })
    expect(index.entries.map((e) => e.path)).toEqual(['perso/github.com'])
    expect(index.problems).toEqual([])
    expect(calls.some((c) => c.path === 'secret/metadata/')).toBe(false)
  })

  test('reads credentials, resolving unknown mounts once', async () => {
    const { client, calls } = await session()
    await client.kvMounts()

    const gitlab = { mount: 'secret', path: 'gitlab', title: 'g', urls: [], inferred: false }
    expect(await client.readCredential(gitlab)).toEqual({ username: 'julien', password: 'pw', totpSeed: null })

    const wiki = { mount: 'team', path: 'wiki', title: 'w', urls: [], inferred: false }
    expect(await client.readCredential(wiki)).toMatchObject({ username: 'team' })
    expect(await client.readCredential(wiki)).toMatchObject({ password: 'w' })
    expect(calls.filter((c) => c.path === 'sys/internal/ui/mounts/team')).toHaveLength(1)

    const grafana = { mount: 'secret', path: 'pro/grafana', title: 'x', urls: [], inferred: false }
    await expect(client.readCredential(grafana)).rejects.toMatchObject({ kind: 'permission' })
  })

  test('resume needs no network', () => {
    const { fetch, calls } = server()
    const vault = new VaultClient({ address: 'http://v', fetch })
    const saved: Session = {
      token: 't',
      accessor: 'a',
      policies: [],
      ttl: 1,
      renewable: false,
      observedAt: 0,
      method: 'token',
    }
    expect(vault.resume(saved).session).toBe(saved)
    expect(calls).toHaveLength(0)
  })
})
