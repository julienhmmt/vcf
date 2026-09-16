import { describe, expect, test } from 'vitest'
import { VaultHttp } from './http'
import { KvClient } from './kv'
import { buildIndex } from './indexer'
import { denied, fakeVault, listReply } from './fake-server.test-helper'

function meta(custom: Record<string, string> | null) {
  return { body: { data: { custom_metadata: custom } } }
}

function client(routes: Parameters<typeof fakeVault>[0], version: 1 | 2 = 2) {
  const { fetch, calls } = fakeVault(routes)
  const mount = { path: version === 2 ? 'secret' : 'legacy', version, description: '' }
  return { kv: new KvClient(new VaultHttp({ address: 'http://v', fetch }), 't', mount), calls }
}

describe('buildIndex', () => {
  test('kv-v2: metadata only, problems collected', async () => {
    const { kv, calls } = client({
      'LIST secret/metadata/': listReply(['gitlab', 'github.com', 'notes', 'ignored', 'locked', 'pro/']),
      'GET secret/metadata/gitlab': meta({ url: 'https://gitlab.example.net', title: 'GitLab' }),
      'GET secret/metadata/github.com': meta(null),
      'GET secret/metadata/notes': meta(null),
      'GET secret/metadata/ignored': meta({ url: 'https://x.net', vcf: 'ignore' }),
      'GET secret/metadata/locked': denied,
      'LIST secret/metadata/pro/': denied,
    })

    const result = await buildIndex(kv, { concurrency: 2 })

    expect(result.entries.map((e) => [e.path, e.title, e.inferred])).toEqual([
      ['github.com', 'github.com', true],
      ['gitlab', 'GitLab', false],
    ])
    expect(result.scanned).toBe(5)
    expect(result.problems.map((p) => [p.mount, p.path, p.error.kind])).toEqual([
      ['secret', 'locked', 'permission'],
      ['secret', 'pro/', 'permission'],
    ])
    expect(calls.some((c) => c.path.includes('/data/'))).toBe(false)
  })

  test('kv-v1: path inference, no reads', async () => {
    const { kv, calls } = client(
      {
        'LIST legacy/': listReply(['sites/']),
        'LIST legacy/sites/': listReply(['example.org', 'intranet']),
      },
      1,
    )
    const result = await buildIndex(kv)
    expect(result.entries.map((e) => e.path)).toEqual(['sites/example.org'])
    expect(result.scanned).toBe(2)
    expect(calls.every((c) => c.method === 'LIST')).toBe(true)
  })

  test('network errors abort', async () => {
    let first = true
    const http = new VaultHttp({
      address: 'http://v',
      fetch: async () => {
        if (first) {
          first = false
          return new Response(JSON.stringify({ data: { keys: ['a'] } }))
        }
        throw new TypeError('offline')
      },
    })
    const kv = new KvClient(http, 't', { path: 'secret', version: 2, description: '' })
    await expect(buildIndex(kv, { signal: new AbortController().signal })).rejects.toMatchObject({
      kind: 'network',
    })
  })

  test('protocol errors are recorded, foreign errors abort', async () => {
    const { kv } = client({
      'LIST secret/metadata/': listReply(['a']),
      'GET secret/metadata/a': { body: '"a string"' },
    })
    const result = await buildIndex(kv)
    expect(result.problems[0]?.error.kind).toBe('protocol')

    kv.readMetadata = () => Promise.reject(new RangeError('bug'))
    await expect(buildIndex(kv)).rejects.toThrow(RangeError)
  })
})
