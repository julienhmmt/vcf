import { describe, expect, test } from 'vitest'
import { extractCredential } from './credential'

describe('extractCredential', () => {
  test('uses default keys in priority order', () => {
    expect(extractCredential({}, { login: 'l', user: 'u', password: 'p', secret: 's' })).toEqual({
      username: 'u',
      password: 'p',
      totpSeed: null,
    })
  })

  test('falls back to email', () => {
    expect(extractCredential({}, { email: 'a@b.c', pass: 'x' })).toMatchObject({
      username: 'a@b.c',
      password: 'x',
    })
  })

  test('matches default keys case-insensitively as a last resort', () => {
    expect(extractCredential({}, { Username: 'U', PASSWORD: 'P' })).toMatchObject({
      username: 'U',
      password: 'P',
    })
  })

  test('prefers an exact key over a case-insensitive one', () => {
    expect(extractCredential({}, { User: 'loose', login: 'exact' }).username).toBe('exact')
  })

  test('declared keys are authoritative, even when missing', () => {
    const entry = { usernameKey: 'account', passwordKey: 'pin', totpKey: 'otp' }
    expect(extractCredential(entry, { username: 'ignored', password: 'ignored', otp: 'SEED' })).toEqual({
      username: null,
      password: null,
      totpSeed: 'SEED',
    })
  })

  test('stringifies scalars and ignores structured values', () => {
    expect(extractCredential({}, { username: 42, password: { nested: true } })).toEqual({
      username: '42',
      password: null,
      totpSeed: null,
    })
    expect(extractCredential({ passwordKey: 'flag' }, { flag: true }).password).toBe('true')
  })

  test('no TOTP without a declared key', () => {
    expect(extractCredential({}, { totp: 'SEED' }).totpSeed).toBeNull()
  })
})
