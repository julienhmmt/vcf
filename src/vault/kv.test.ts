import { describe, expect, test } from 'vitest'
import { VaultHttp } from './http'
import { KvClient } from './kv'
import { denied, fakeVault, listReply } from './fake-server.test-helper'
import type { VaultError } from './errors'

const v2 = { path: 'secret', version: 2 as const, description: '' }
const v1 = { path: 'legacy', version: 1 as const, description: '' }

function kv(routes: Parameters<typeof fakeVault>[0], mount: typeof v2 | typeof v1 = v2) {
  const { fetch, calls } = fakeVault(routes)
  return { client: new KvClient(new VaultHttp({ address: 'http://v', fetch }), 'tok', mount), calls }
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = []
  for await (const item of gen) out.push(item)
  return out
}

describe('list', () => {
  test('kv-v2 lists metadata', async () => {
    const { client, calls } = kv({ 'LIST secret/metadata/perso/': listReply(['a', 'b/']) })
    expect(await client.list('/perso/')).toEqual(['a', 'b/'])
    expect(calls[0]?.headers['X-Vault-Token']).toBe('tok')
  })

  test('kv-v1 lists the path itself', async () => {
    const { client } = kv({ 'LIST legacy/': listReply(['x']) }, v1)
    expect(await client.list()).toEqual(['x'])
  })

  test('404 is an empty directory', async () => {
    const { client } = kv({})
    expect(await client.list('nope')).toEqual([])
  })

  test('drops junk keys', async () => {
    const { client } = kv({
      'LIST secret/metadata/': { body: { data: { keys: ['ok', 3, null] } } },
      'LIST secret/metadata/x/': { body: { data: { keys: 'nope' } } },
    })
    expect(await client.list()).toEqual(['ok'])
    expect(await client.list('x')).toEqual([])
  })

  test('other errors propagate', async () => {
    const { client } = kv({ 'LIST secret/metadata/': denied })
    await expect(client.list()).rejects.toMatchObject({ kind: 'permission' })
  })
})

describe('readMetadata', () => {
  test('returns custom_metadata, {} when null', async () => {
    const { client } = kv({
      'GET secret/metadata/a': { body: { data: { custom_metadata: { url: 'https://a.net' } } } },
      'GET secret/metadata/b': { body: { data: { custom_metadata: null } } },
    })
    expect(await client.readMetadata('a')).toEqual({ url: 'https://a.net' })
    expect(await client.readMetadata('b')).toEqual({})
  })

  test('kv-v1 never calls the server', async () => {
    const { client, calls } = kv({}, v1)
    expect(await client.readMetadata('a')).toEqual({})
    expect(calls).toHaveLength(0)
  })
})

describe('readData', () => {
  test('kv-v2 unwraps data.data', async () => {
    const { client } = kv({ 'GET secret/data/a': { body: { data: { data: { password: 'p' } } } } })
    expect(await client.readData('a')).toEqual({ password: 'p' })
  })

  test('kv-v2 soft-deleted version is not found', async () => {
    const { client } = kv({
      'GET secret/data/gone': {
        status: 404,
        body: { data: { data: null, metadata: { deletion_time: 'x' } } },
      },
      'GET secret/data/odd': { body: { data: { data: null } } },
      'GET secret/data/odder': { body: { data: null } },
    })
    await expect(client.readData('gone')).rejects.toMatchObject({ kind: 'not_found' })
    await expect(client.readData('odd')).rejects.toMatchObject({ kind: 'not_found' })
    await expect(client.readData('odder')).rejects.toMatchObject({ kind: 'not_found' })
  })

  test('kv-v1 returns data directly', async () => {
    const { client } = kv(
      {
        'GET legacy/site': { body: { data: { username: 'u' } } },
        'GET legacy/empty': { body: { data: null } },
      },
      v1,
    )
    expect(await client.readData('site')).toEqual({ username: 'u' })
    await expect(client.readData('empty')).rejects.toMatchObject({ kind: 'not_found' })
  })

  test('policy denial', async () => {
    const { client } = kv({ 'GET secret/data/pro/x': denied })
    await expect(client.readData('pro/x')).rejects.toMatchObject({ kind: 'permission' })
  })
})

describe('walk', () => {
  const tree = {
    'LIST secret/metadata/': listReply(['top', 'perso/', 'pro/']),
    'LIST secret/metadata/perso/': listReply(['a', 'infra/']),
    'LIST secret/metadata/perso/infra/': listReply(['pve']),
    'LIST secret/metadata/pro/': denied,
  }

  test('breadth-first, skipping denied subtrees', async () => {
    const { client } = kv(tree)
    const problems: Array<[string, VaultError]> = []
    const paths = await collect(client.walk('', { concurrency: 1, onError: (d, e) => problems.push([d, e]) }))
    expect(paths).toEqual(['top', 'perso/a', 'perso/infra/pve'])
    expect(problems.map(([dir, e]) => [dir, e.kind])).toEqual([['pro/', 'permission']])
  })

  test('prefix and depth limit', async () => {
    const { client } = kv(tree)
    expect(await collect(client.walk('/perso/', { maxDepth: 0 }))).toEqual(['perso/a'])
    expect(await collect(client.walk('perso'))).toEqual(['perso/a', 'perso/infra/pve'])
  })

  test('denied subtree without a callback', async () => {
    const { client } = kv(tree)
    expect(await collect(client.walk('pro'))).toEqual([])
  })

  test('fatal errors stop the walk', async () => {
    const { client } = kv({ 'LIST secret/metadata/': { status: 500 } })
    await expect(collect(client.walk())).rejects.toMatchObject({ kind: 'server' })
  })
})
