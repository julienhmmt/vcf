import { describe, expect, test } from 'vitest'
import { parseUrl, parseUrlList, toIndexEntry } from './metadata'

describe('parseUrl', () => {
  test('parses a full https url', () => {
    const parsed = parseUrl('https://gitlab.example.net/users/sign_in')

    expect(parsed).not.toBeNull()
    expect(parsed?.hostname).toBe('gitlab.example.net')
    expect(parsed?.scheme).toBe('https')
    expect(parsed?.pathPrefix).toBe('/users/sign_in')
  })

  test('accepts a bare hostname and leaves the scheme unset', () => {
    const parsed = parseUrl('github.com')

    expect(parsed?.hostname).toBe('github.com')
    expect(parsed?.scheme).toBeUndefined()
  })

  test('lowercases the hostname', () => {
    expect(parseUrl('https://GitLab.Example.NET')?.hostname).toBe(
      'gitlab.example.net',
    )
  })

  test('trims surrounding whitespace', () => {
    expect(parseUrl('  github.com  ')?.hostname).toBe('github.com')
  })

  test('omits the path prefix for a bare root path', () => {
    expect(parseUrl('https://example.net/')?.pathPrefix).toBeUndefined()
    expect(parseUrl('https://example.net')?.pathPrefix).toBeUndefined()
  })

  test('drops query string and fragment', () => {
    const parsed = parseUrl('https://example.net/login?next=/a#form')
    expect(parsed?.pathPrefix).toBe('/login')
  })

  test('resolves a multi-label public suffix', () => {
    expect(parseUrl('https://shop.example.co.uk')?.domain).toBe('example.co.uk')
  })

  test('reports no registrable domain for a bare host', () => {
    expect(parseUrl('http://localhost:8200')?.domain).toBeNull()
    expect(parseUrl('http://vault-01:8200')?.domain).toBeNull()
  })

  test('keeps an ip address as its own hostname with no domain', () => {
    const parsed = parseUrl('https://192.168.1.10:8200')

    expect(parsed?.hostname).toBe('192.168.1.10')
    expect(parsed?.domain).toBeNull()
  })

  test('ignores the port, which is never compared', () => {
    expect(parseUrl('https://example.net:8443')?.hostname).toBe('example.net')
  })

  test('returns null on empty or unusable input', () => {
    expect(parseUrl('')).toBeNull()
    expect(parseUrl('   ')).toBeNull()
    expect(parseUrl('https://')).toBeNull()
    expect(parseUrl('not a url at all')).toBeNull()
  })

  test('preserves a non-http scheme rather than guessing', () => {
    expect(parseUrl('ftp://files.example.net')?.scheme).toBe('ftp')
  })
})

describe('parseUrlList', () => {
  test('splits on commas and trims each entry', () => {
    const parsed = parseUrlList('https://a.example.net , b.example.net')
    expect(parsed.map((url) => url.hostname)).toEqual([
      'a.example.net',
      'b.example.net',
    ])
  })

  test('skips unusable entries instead of failing the whole list', () => {
    const parsed = parseUrlList('https://a.example.net,,   ,not a url')
    expect(parsed.map((url) => url.hostname)).toEqual(['a.example.net'])
  })

  test('returns an empty list when nothing is usable', () => {
    expect(parseUrlList(',,,')).toEqual([])
  })
})

describe('toIndexEntry', () => {
  test('parses a declared url and title', () => {
    const entry = toIndexEntry('secret', 'perso/gitlab', {
      url: 'https://gitlab.example.net',
      title: 'GitLab interne',
    })

    expect(entry?.mount).toBe('secret')
    expect(entry?.path).toBe('perso/gitlab')
    expect(entry?.title).toBe('GitLab interne')
    expect(entry?.urls).toHaveLength(1)
    expect(entry?.inferred).toBe(false)
  })

  test('defaults the title to the last path segment', () => {
    const entry = toIndexEntry('secret', 'perso/team/gitlab', {
      url: 'https://gitlab.example.net',
    })

    expect(entry?.title).toBe('gitlab')
  })

  test('falls back to the last path segment as a hostname', () => {
    const entry = toIndexEntry('secret', 'perso/github.com')

    expect(entry?.inferred).toBe(true)
    expect(entry?.urls[0]?.hostname).toBe('github.com')
  })

  test('rejects a path segment with no dot, which cannot be a hostname', () => {
    expect(toIndexEntry('secret', 'perso/gitlab')).toBeNull()
    expect(toIndexEntry('secret', 'perso/vault-prod')).toBeNull()
  })

  test('accepts a dotted internal hostname as an inferred url', () => {
    const entry = toIndexEntry('secret', 'perso/pve.internal')

    expect(entry?.inferred).toBe(true)
    expect(entry?.urls[0]?.hostname).toBe('pve.internal')
  })

  test('prefers a declared url over the path even when both look valid', () => {
    const entry = toIndexEntry('secret', 'perso/github.com', {
      url: 'https://gitlab.example.net',
    })

    expect(entry?.inferred).toBe(false)
    expect(entry?.urls[0]?.hostname).toBe('gitlab.example.net')
  })

  test('falls back to the path when the declared url is unusable', () => {
    const entry = toIndexEntry('secret', 'perso/github.com', { url: '   ' })

    expect(entry?.inferred).toBe(true)
    expect(entry?.urls[0]?.hostname).toBe('github.com')
  })

  test('honours the ignore opt-out whatever else is declared', () => {
    const entry = toIndexEntry('secret', 'perso/x', {
      url: 'https://example.net',
      vcf: 'IGNORE',
    })

    expect(entry).toBeNull()
  })

  test('reads the explicit data key overrides', () => {
    const entry = toIndexEntry('secret', 'perso/x', {
      url: 'https://example.net',
      username_key: 'login',
      password_key: 'pass',
      totp_key: 'otp',
    })

    expect(entry?.usernameKey).toBe('login')
    expect(entry?.passwordKey).toBe('pass')
    expect(entry?.totpKey).toBe('otp')
  })

  test('leaves the data key overrides unset when blank', () => {
    const entry = toIndexEntry('secret', 'perso/x', {
      url: 'https://example.net',
      username_key: '  ',
    })

    expect(entry?.usernameKey).toBeUndefined()
  })

  test('accepts a known strictness case-insensitively', () => {
    const entry = toIndexEntry('secret', 'perso/x', {
      url: 'https://example.net',
      match: 'HOST',
    })

    expect(entry?.strictness).toBe('host')
  })

  test('ignores an unknown strictness instead of throwing', () => {
    const entry = toIndexEntry('secret', 'perso/x', {
      url: 'https://example.net',
      match: 'wat',
    })

    expect(entry?.strictness).toBeUndefined()
  })

  test('works with no metadata at all', () => {
    expect(toIndexEntry('secret', 'perso/github.com')).not.toBeNull()
  })

  test('tolerates a trailing slash in the path', () => {
    const entry = toIndexEntry('secret', 'perso/github.com/')
    expect(entry?.title).toBe('github.com')
  })
})
