import { describe, expect, test } from 'vitest'
import { VaultHttp } from './http'
import { describeMount, discoverKvMounts, listRoots, readResultantAcl } from './mounts'
import { fakeVault } from './fake-server.test-helper'

function http(routes: Parameters<typeof fakeVault>[0]) {
  return new VaultHttp({ address: 'http://v', fetch: fakeVault(routes).fetch })
}

describe('discoverKvMounts', () => {
  test('keeps kv engines only, with their version', async () => {
    const client = http({
      'GET sys/internal/ui/mounts': {
        body: {
          data: {
            secret: {
              'secret/': { type: 'kv', options: { version: '2' }, description: 'main' },
              'legacy/': { type: 'kv', options: { version: '1' } },
              'old/': { type: 'generic', options: null },
              'cubbyhole/': { type: 'cubbyhole' },
              'pki/': { type: 'pki' },
              'nested/kv/': { type: 'kv', options: { version: '2' } },
              'weird/': {},
            },
          },
        },
      },
    })

    expect(await discoverKvMounts(client, 't')).toEqual([
      { path: 'legacy', version: 1, description: '' },
      { path: 'nested/kv', version: 2, description: '' },
      { path: 'old', version: 1, description: '' },
      { path: 'secret', version: 2, description: 'main' },
    ])
  })

  test('empty when the server shows nothing', async () => {
    expect(await discoverKvMounts(http({ 'GET sys/internal/ui/mounts': { body: { data: {} } } }), 't')).toEqual([])
    expect(await discoverKvMounts(http({ 'GET sys/internal/ui/mounts': { body: {} } }), 't')).toEqual([])
  })
})

describe('describeMount', () => {
  test('returns the real mount root', async () => {
    const client = http({
      'GET sys/internal/ui/mounts/team/sub': {
        body: { data: { type: 'kv', path: 'team/', options: { version: '2' } } },
      },
    })
    expect(await describeMount(client, 't', '/team/sub/')).toEqual({ path: 'team', version: 2, description: '' })
  })

  test('falls back to the input path', async () => {
    const client = http({
      'GET sys/internal/ui/mounts/kv': { body: { data: { type: 'kv' } } },
    })
    expect(await describeMount(client, 't', 'kv')).toMatchObject({ path: 'kv', version: 1 })
  })

  test('refuses non-kv engines', async () => {
    const client = http({
      'GET sys/internal/ui/mounts/pki': { body: { data: { type: 'pki' } } },
      'GET sys/internal/ui/mounts/none': { body: {} },
    })
    await expect(describeMount(client, 't', 'pki')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(describeMount(client, 't', 'none')).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('listRoots', () => {
  const v2 = { path: 'secret', version: 2 as const, description: '' }
  const v1 = { path: 'legacy', version: 1 as const, description: '' }
  const list = { capabilities: ['list', 'read'] }
  const readOnly = { capabilities: ['read'] }

  test('whole mount when the ACL is missing, root, or grants nothing', () => {
    expect(listRoots(null, v2)).toEqual([''])
    expect(listRoots({ root: true }, v2)).toEqual([''])
    expect(listRoots({}, v2)).toEqual([''])
    expect(listRoots({ glob_paths: { 'secret/data/': readOnly } }, v2)).toEqual([''])
  })

  test('mount-wide globs', () => {
    expect(listRoots({ glob_paths: { 'secret/metadata/': list } }, v2)).toEqual([''])
    expect(listRoots({ glob_paths: { 'secret/': list } }, v2)).toEqual([''])
    expect(listRoots({ glob_paths: { '': list } }, v2)).toEqual([''])
    expect(listRoots({ glob_paths: { 'legacy/': list } }, v1)).toEqual([''])
  })

  test('scoped globs, deduplicated to the shallowest', () => {
    const acl = {
      glob_paths: {
        'secret/metadata/perso/': list,
        'secret/metadata/perso/infra/': list,
        'secret/metadata/team/': list,
        'secret/metadata/denied/': { capabilities: ['deny'] },
        'other/metadata/': list,
        'secret/metadata/x/': {},
      },
    }
    expect(listRoots(acl, v2)).toEqual(['perso/', 'team/'])
  })

  test('mid-segment glob lists its parent', () => {
    expect(listRoots({ glob_paths: { 'secret/metadata/apps/web-': list } }, v2)).toEqual(['apps/'])
  })

  test('plus wildcard stops the root above it', () => {
    expect(listRoots({ glob_paths: { 'secret/metadata/teams/+/web/': list } }, v2)).toEqual(['teams/'])
  })

  test('exact paths count only as directories', () => {
    const acl = {
      exact_paths: {
        'secret/metadata/shared/': list,
        'secret/metadata/single': list,
        'secret/metadata/': readOnly,
      },
    }
    expect(listRoots(acl, v2)).toEqual(['shared/'])
  })
})

describe('readResultantAcl', () => {
  test('returns the data, or null when refused', async () => {
    const ok = http({ 'GET sys/internal/ui/resultant-acl': { body: { data: { root: true } } } })
    expect(await readResultantAcl(ok, 't')).toEqual({ root: true })
    expect(await readResultantAcl(http({}), 't')).toBeNull()
    const denied = http({ 'GET sys/internal/ui/resultant-acl': { status: 403 } })
    expect(await readResultantAcl(denied, 't')).toBeNull()
  })

  test('other failures propagate', async () => {
    const broken = http({ 'GET sys/internal/ui/resultant-acl': { status: 500 } })
    await expect(readResultantAcl(broken, 't')).rejects.toMatchObject({ kind: 'server' })
  })
})
