import { describe, expect, test } from 'vitest'
import { VaultHttp, normaliseAddress } from './http'
import { VaultError, isVaultError, kindForStatus } from './errors'
import { denied, fakeVault } from './fake-server.test-helper'

describe('normaliseAddress', () => {
  test.each([
    ['https://vault.example.net:8200/', 'https://vault.example.net:8200'],
    ['  http://127.0.0.1:8200  ', 'http://127.0.0.1:8200'],
    ['https://example.net/vault/', 'https://example.net/vault'],
    ['https://example.net/vault/v1/', 'https://example.net/vault'],
    ['https://example.net/v1', 'https://example.net'],
  ])('%s → %s', (raw, expected) => {
    expect(normaliseAddress(raw)).toBe(expected)
  })

  test.each(['vault.example.net', 'ftp://vault', 'https://u:p@vault.example.net', ''])(
    'rejects %s',
    (raw) => {
      expect(() => normaliseAddress(raw)).toThrow(VaultError)
    },
  )
})

describe('VaultHttp', () => {
  test('sends token, namespace and request headers', async () => {
    const { fetch, calls } = fakeVault({ 'GET sys/thing': { body: { data: { ok: true } } } })
    const http = new VaultHttp({ address: 'http://v:8200', namespace: '/team-a/', fetch })

    const response = await http.get<{ ok: boolean }>('/sys/thing', { token: 't0k' })

    expect(response.data).toEqual({ ok: true })
    expect(response.auth).toBeNull()
    expect(calls[0]?.headers).toMatchObject({
      'X-Vault-Token': 't0k',
      'X-Vault-Namespace': 'team-a',
      'X-Vault-Request': 'true',
    })
  })

  test('omits optional headers and serialises bodies', async () => {
    const { fetch, calls } = fakeVault({ 'POST auth/x': { status: 204 } })
    const http = new VaultHttp({ address: 'http://v', namespace: '  ', fetch })

    const response = await http.post('auth/x', { body: { a: 1 } })

    expect(response).toEqual({ data: null, auth: null })
    expect(calls[0]?.headers['X-Vault-Token']).toBeUndefined()
    expect(calls[0]?.headers['X-Vault-Namespace']).toBeUndefined()
    expect(calls[0]?.headers['Content-Type']).toBe('application/json')
    expect(calls[0]?.body).toEqual({ a: 1 })
  })

  test('list uses GET with list=true and keeps other query params', async () => {
    const seen: string[] = []
    const fetch = async (input: string, init: RequestInit) => {
      seen.push(`${init.method} ${input}`)
      return new Response('{"data":{"keys":[]}}')
    }
    const http = new VaultHttp({ address: 'http://v', fetch })
    await http.list('kv/metadata/a b/', { query: { x: '1' } })
    expect(seen).toEqual(['GET http://v/v1/kv/metadata/a%20b/?x=1&list=true'])
  })

  test('maps statuses and tidies multierror messages', async () => {
    const { fetch } = fakeVault({ 'GET secret/data/x': denied })
    const http = new VaultHttp({ address: 'http://v', fetch })

    const error = await http.get('secret/data/x').catch((e: unknown) => e)

    expect(isVaultError(error, 'permission')).toBe(true)
    expect(error).toMatchObject({
      message: 'permission denied',
      status: 403,
      details: { path: 'secret/data/x', errors: ['permission denied'] },
    })
  })

  test('falls back to HTTP status or raw text when errors are absent', async () => {
    const { fetch } = fakeVault({
      'GET a': { status: 500, body: { errors: [] } },
      'GET b': { status: 502, body: 'Bad Gateway' },
    })
    const http = new VaultHttp({ address: 'http://v', fetch })
    await expect(http.get('a')).rejects.toMatchObject({ kind: 'server', message: 'HTTP 500' })
    await expect(http.get('b')).rejects.toMatchObject({ kind: 'server', message: 'Bad Gateway' })
  })

  test('rejects a 2xx body that is not an object', async () => {
    const { fetch } = fakeVault({ 'GET a': { body: '"just a string"' } })
    const http = new VaultHttp({ address: 'http://v', fetch })
    await expect(http.get('a')).rejects.toMatchObject({ kind: 'protocol' })
  })

  test('network failure', async () => {
    const http = new VaultHttp({
      address: 'http://v',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    })
    await expect(http.get('a')).rejects.toMatchObject({
      kind: 'network',
      message: 'Cannot reach Vault: Failed to fetch',
    })
  })

  test('non-Error rejection', async () => {
    const http = new VaultHttp({ address: 'http://v', fetch: () => Promise.reject('boom') })
    await expect(http.get('a')).rejects.toMatchObject({ kind: 'network' })
  })

  test('timeout', async () => {
    const http = new VaultHttp({ address: 'http://v', timeoutMs: 10, fetch: hangingFetch })
    await expect(http.get('a')).rejects.toMatchObject({ kind: 'timeout' })
  })

  test('caller abort', async () => {
    const http = new VaultHttp({ address: 'http://v', fetch: hangingFetch })
    const controller = new AbortController()
    const pending = http.get('a', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
  })

  test('uses global fetch by default', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response('{"data":{"v":1}}')
    try {
      const http = new VaultHttp({ address: 'http://v' })
      await expect(http.get('x')).resolves.toMatchObject({ data: { v: 1 } })
    } finally {
      globalThis.fetch = original
    }
  })
})

test('kindForStatus', () => {
  expect([400, 401, 403, 404, 429, 503, 500].map(kindForStatus)).toEqual([
    'invalid',
    'unauthenticated',
    'permission',
    'not_found',
    'rate_limited',
    'sealed',
    'server',
  ])
})

test('VaultError keeps its cause', () => {
  const cause = new Error('root')
  const error = new VaultError('network', 'x', { cause })
  expect(error.cause).toBe(cause)
  expect(error.name).toBe('VaultError')
  expect(isVaultError(new Error('x'))).toBe(false)
})

function hangingFetch(_: string, init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })
}
