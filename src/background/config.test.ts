import { describe, expect, test } from 'vitest'
import { ConfigError, hostPattern, indexFingerprint, parseConfig } from './config'

const base = { address: 'https://vault.example.net:8200/', auth: { method: 'token' } }

describe('parseConfig', () => {
  test('applies defaults', () => {
    expect(parseConfig(base)).toEqual({
      address: 'https://vault.example.net:8200',
      namespace: '',
      auth: { method: 'token' },
      mounts: { mode: 'auto' },
      lockAfterMinutes: 30,
      refreshEveryMinutes: 15,
    })
  })

  test('full config', () => {
    const config = parseConfig({
      ...base,
      namespace: ' /team/a/ ',
      auth: { method: 'userpass', username: ' julien ', mount: '/corp-up/' },
      mounts: { mode: 'manual', paths: ['/secret/', 'team', 'secret'] },
      lockAfterMinutes: 5,
      refreshEveryMinutes: 60,
    })
    expect(config).toMatchObject({
      namespace: 'team/a',
      auth: { method: 'userpass', username: 'julien', mount: 'corp-up' },
      mounts: { mode: 'manual', paths: ['secret', 'team'] },
      lockAfterMinutes: 5,
      refreshEveryMinutes: 60,
    })
  })

  test.each([
    [{ ...base, auth: { method: 'ldap', username: 'j' } }, { method: 'ldap', mount: 'ldap', username: 'j' }],
    [{ ...base, auth: { method: 'approle', roleId: 'r' } }, { method: 'approle', mount: 'approle', roleId: 'r' }],
    [{ ...base, auth: { method: 'oidc', role: 'vcf' } }, { method: 'oidc', mount: 'oidc', role: 'vcf' }],
    [{ ...base, auth: { method: 'oidc' } }, { method: 'oidc', mount: 'oidc', role: '' }],
  ])('auth %#', (input, auth) => {
    expect(parseConfig(input).auth).toEqual(auth)
  })

  test('explicit auto mounts', () => {
    expect(parseConfig({ ...base, mounts: { mode: 'auto' } }).mounts).toEqual({ mode: 'auto' })
  })

  test.each([
    [null, 'config: must be an object'],
    [[], 'config: must be an object'],
    [{ ...base, address: 'vault' }, 'address'],
    [{ ...base, address: 42 }, 'address'],
    [{ ...base, namespace: 3 }, 'namespace: must be a string'],
    [{ ...base, auth: undefined }, 'auth: must be an object'],
    [{ ...base, auth: { method: 'kerberos' } }, 'auth.method'],
    [{ ...base, auth: { method: 'userpass' } }, 'auth.username: required'],
    [{ ...base, auth: { method: 'userpass', username: 'a/b' } }, 'must not contain'],
    [{ ...base, auth: { method: 'approle', roleId: ' ' } }, 'auth.roleId'],
    [{ ...base, mounts: { mode: 'x' } }, 'mounts.mode'],
    [{ ...base, mounts: { mode: 'manual', paths: 'secret' } }, 'mounts.paths: must be a list'],
    [{ ...base, mounts: { mode: 'manual', paths: [] } }, 'at least one'],
    [{ ...base, mounts: { mode: 'manual', paths: ['/'] } }, 'mounts.paths[0]: empty'],
    [{ ...base, mounts: { mode: 'manual', paths: [1] } }, 'mounts.paths[0]: required'],
    [{ ...base, lockAfterMinutes: 0 }, 'lockAfterMinutes'],
    [{ ...base, lockAfterMinutes: 1.5 }, 'lockAfterMinutes'],
    [{ ...base, refreshEveryMinutes: '15' }, 'refreshEveryMinutes'],
    [{ ...base, refreshEveryMinutes: 100_000 }, 'refreshEveryMinutes'],
  ])('rejects %j', (input, message) => {
    expect(() => parseConfig(input)).toThrow(ConfigError)
    expect(() => parseConfig(input)).toThrow(message)
  })
})

test('fingerprint ignores timing settings only', () => {
  const a = parseConfig(base)
  expect(indexFingerprint(a)).toBe(indexFingerprint({ ...a, lockAfterMinutes: 1, refreshEveryMinutes: 2 }))
  expect(indexFingerprint(a)).not.toBe(indexFingerprint({ ...a, namespace: 'x' }))
})

test('hostPattern', () => {
  expect(hostPattern('https://example.net:8200/vault')).toBe('https://example.net:8200/*')
})
