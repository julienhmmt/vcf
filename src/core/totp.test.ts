import { describe, expect, test } from 'vitest'
import { decodeBase32, parseTotpSeed, totp } from './totp'

const ascii = (s: string) => new TextEncoder().encode(s)

describe('RFC 6238 vectors', () => {
  const cases = [
    ['SHA-1', '12345678901234567890', 59, '94287082'],
    ['SHA-256', '12345678901234567890123456789012', 59, '46119246'],
    ['SHA-512', '1234567890123456789012345678901234567890123456789012345678901234', 59, '90693936'],
    ['SHA-1', '12345678901234567890', 1111111109, '07081804'],
    ['SHA-1', '12345678901234567890', 20000000000, '65353130'],
  ] as const

  test.each(cases)('%s at %i', async (algorithm, secret, time, expected) => {
    const result = await totp({ secret: ascii(secret), algorithm, digits: 8, period: 30 }, time * 1000)
    expect(result.code).toBe(expected)
  })

  test('remaining seconds', async () => {
    const params = { secret: ascii('12345678901234567890'), algorithm: 'SHA-1' as const, digits: 6, period: 30 }
    expect((await totp(params, 59_000)).remaining).toBe(1)
    expect((await totp(params, 60_000)).remaining).toBe(30)
  })
})

describe('decodeBase32', () => {
  test('decodes with padding, spaces and lower case', () => {
    expect(new TextDecoder().decode(decodeBase32('jbsw-y3dp'))).toBe('Hello')
    expect(Array.from(decodeBase32('MZXW6==='))).toEqual([0x66, 0x6f, 0x6f])
  })

  test('rejects junk', () => {
    expect(() => decodeBase32('')).toThrow('Empty')
    expect(() => decodeBase32('abc1')).toThrow('base32')
  })
})

describe('parseTotpSeed', () => {
  test('bare secret gets defaults', () => {
    expect(parseTotpSeed(' JBSWY3DPEHPK3PXP ')).toMatchObject({ algorithm: 'SHA-1', digits: 6, period: 30 })
  })

  test('otpauth URI with parameters', () => {
    const params = parseTotpSeed(
      'otpauth://totp/ACME:julien?secret=MZXW6===&issuer=ACME&algorithm=SHA256&digits=8&period=60',
    )
    expect(params).toMatchObject({ algorithm: 'SHA-256', digits: 8, period: 60 })
    expect(Array.from(params.secret)).toEqual([0x66, 0x6f, 0x6f])
  })

  test.each([
    ['otpauth://hotp/x?secret=MZXW6', 'Only TOTP'],
    ['otpauth://totp/x', 'no secret'],
    ['otpauth://totp/x?secret=MZXW6&algorithm=MD5', 'MD5'],
    ['otpauth://totp/x?secret=MZXW6&digits=4', 'digits'],
    ['otpauth://totp/x?secret=MZXW6&period=0', 'period'],
    ['otpauth://totp/x?secret=MZXW6&period=abc', 'period'],
  ])('%s', (uri, message) => {
    expect(() => parseTotpSeed(uri)).toThrow(message)
  })
})
