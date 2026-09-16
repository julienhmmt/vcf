import { describe, expect, test } from 'vitest'
import { toIndexEntry } from './metadata'
import { findMatches } from './matcher'
import { MatchQuality } from './types'
import type { IndexEntry } from './types'

function entry(path: string, metadata: Record<string, string> = {}): IndexEntry {
  const built = toIndexEntry('secret', path, metadata)
  if (built === null) throw new Error(`fixture ${path} produced no entry`)
  return built
}

const gitlab = entry('perso/gitlab', { url: 'https://gitlab.example.net' })
const wiki = entry('perso/wiki', { url: 'https://wiki.example.net' })
const apex = entry('perso/apex', { url: 'https://example.net' })

describe('findMatches — ranking', () => {
  test('ranks host, subdomain and domain matches in that order', () => {
    const matches = findMatches('https://gitlab.example.net/users/sign_in', [
      wiki,
      gitlab,
      apex,
    ])

    expect(matches.map((match) => match.entry.path)).toEqual([
      'perso/gitlab',
      'perso/apex',
      'perso/wiki',
    ])
    expect(matches.map((match) => match.quality)).toEqual([
      MatchQuality.Host,
      MatchQuality.Subdomain,
      MatchQuality.Domain,
    ])
  })

  test('treats a page below the entry host as a subdomain match', () => {
    const matches = findMatches('https://ci.gitlab.example.net', [gitlab])
    expect(matches[0]?.quality).toBe(MatchQuality.Subdomain)
  })

  test('treats an entry below the page host as a subdomain match', () => {
    const matches = findMatches('https://example.net', [gitlab])
    expect(matches[0]?.quality).toBe(MatchQuality.Subdomain)
  })

  test('breaks a quality tie on the declared flag, then the title', () => {
    const declared = entry('perso/gh', { url: 'https://github.com', title: 'zzz' })
    const guessed = entry('perso/github.com')

    const matches = findMatches('https://github.com', [guessed, declared])

    expect(matches[0]?.entry.inferred).toBe(false)
    expect(matches[1]?.entry.inferred).toBe(true)
  })

  test('sorts equal-quality declared entries by title', () => {
    const beta = entry('a', { url: 'https://example.net', title: 'beta' })
    const alpha = entry('b', { url: 'https://example.net', title: 'alpha' })

    const matches = findMatches('https://example.net', [beta, alpha])
    expect(matches.map((match) => match.entry.title)).toEqual(['alpha', 'beta'])
  })

  test('keeps a single match per entry even when several urls match', () => {
    const multi = entry('perso/gitlab', {
      url: 'https://gitlab.example.net,https://example.net',
    })

    const matches = findMatches('https://gitlab.example.net', [multi])

    expect(matches).toHaveLength(1)
    expect(matches[0]?.via.hostname).toBe('gitlab.example.net')
    expect(matches[0]?.quality).toBe(MatchQuality.Host)
  })

  test('reports which url produced the match', () => {
    const multi = entry('perso/gitlab', {
      url: 'https://gitlab.example.net,https://git.example.net',
    })

    const matches = findMatches('https://git.example.net', [multi])
    expect(matches[0]?.via.hostname).toBe('git.example.net')
  })
})

describe('findMatches — exact tier', () => {
  const jira = entry('work/jira', { url: 'https://apps.example.net/jira' })

  test('promotes to exact when the page sits under the declared prefix', () => {
    const matches = findMatches('https://apps.example.net/jira/login', [jira])
    expect(matches[0]?.quality).toBe(MatchQuality.Exact)
  })

  test('stays at host level when the prefix does not match', () => {
    const matches = findMatches('https://apps.example.net/confluence', [jira])
    expect(matches[0]?.quality).toBe(MatchQuality.Host)
  })

  test('refuses to reach exact on a downgraded scheme', () => {
    const matches = findMatches('http://apps.example.net/jira/login', [jira])
    expect(matches[0]?.quality).toBe(MatchQuality.Host)
  })

  test('does not promote an entry that declares no prefix', () => {
    const matches = findMatches('https://gitlab.example.net/anything', [gitlab])
    expect(matches[0]?.quality).toBe(MatchQuality.Host)
  })

  test('ranks the scoped entry above the bare host entry on its own path', () => {
    const apps = entry('work/apps', { url: 'https://apps.example.net' })

    const matches = findMatches('https://apps.example.net/jira/login', [apps, jira])
    expect(matches[0]?.entry.path).toBe('work/jira')
  })
})

describe('findMatches — strictness', () => {
  test('exact rejects anything below the exact tier', () => {
    const strict = entry('work/vpn', {
      url: 'https://vpn.example.net',
      match: 'exact',
    })

    expect(findMatches('https://vpn.example.net', [strict])).toEqual([])
  })

  test('exact accepts a page under the declared prefix', () => {
    const strict = entry('work/vpn', {
      url: 'https://vpn.example.net/portal',
      match: 'exact',
    })

    expect(findMatches('https://vpn.example.net/portal', [strict])).toHaveLength(1)
  })

  test('host rejects a subdomain match', () => {
    const strict = entry('work/vpn', {
      url: 'https://vpn.example.net',
      match: 'host',
    })

    expect(findMatches('https://eu.vpn.example.net', [strict])).toEqual([])
  })

  test('host rejects a domain match', () => {
    const strict = entry('work/vpn', {
      url: 'https://vpn.example.net',
      match: 'host',
    })

    expect(findMatches('https://other.example.net', [strict])).toEqual([])
  })

  test('host accepts a hostname match', () => {
    const strict = entry('work/vpn', {
      url: 'https://vpn.example.net',
      match: 'host',
    })

    expect(findMatches('https://vpn.example.net', [strict])).toHaveLength(1)
  })

  test('domain is the default and accepts every tier', () => {
    const loose = entry('work/vpn', {
      url: 'https://vpn.example.net',
      match: 'domain',
    })

    expect(findMatches('https://other.example.net', [loose])).toHaveLength(1)
  })

  test('applies strictness per url within one entry', () => {
    const mixed = entry('work/x', {
      url: 'https://a.example.net/app,https://b.example.net',
      match: 'exact',
    })

    expect(findMatches('https://b.example.net', [mixed])).toEqual([])
    expect(findMatches('https://a.example.net/app', [mixed])).toHaveLength(1)
  })
})

describe('findMatches — homelab and edge cases', () => {
  test('does not group unrelated hosts that share no registrable domain', () => {
    const vault = entry('lab/vault', { url: 'http://vault-01:8200' })
    const proxmox = entry('lab/pve', { url: 'http://pve-01:8006' })

    const matches = findMatches('http://pve-01:8006', [vault, proxmox])

    expect(matches).toHaveLength(1)
    expect(matches[0]?.entry.path).toBe('lab/pve')
  })

  test('does not group unrelated ip addresses', () => {
    const a = entry('lab/a', { url: 'https://192.168.1.10' })
    const b = entry('lab/b', { url: 'https://192.168.1.20' })

    expect(findMatches('https://192.168.1.20', [a, b])).toHaveLength(1)
  })

  test('matches a bare host exactly', () => {
    const local = entry('lab/vault', { url: 'http://vault-01:8200' })

    const matches = findMatches('http://vault-01:8200/ui/vault/auth', [local])
    expect(matches[0]?.quality).toBe(MatchQuality.Host)
  })

  test('ignores the port when comparing hosts', () => {
    const local = entry('lab/pve', { url: 'https://pve.lan:8006' })

    expect(findMatches('https://pve.lan:9999', [local])).toHaveLength(1)
  })

  test('does not collapse distinct sites under a multi-label public suffix', () => {
    const a = entry('uk/a', { url: 'https://alpha.co.uk' })
    const b = entry('uk/b', { url: 'https://beta.co.uk' })

    expect(findMatches('https://beta.co.uk', [a, b])).toHaveLength(1)
  })

  test('returns nothing for an unrelated site', () => {
    expect(findMatches('https://github.com', [gitlab, wiki, apex])).toEqual([])
  })

  test('returns nothing for an empty index', () => {
    expect(findMatches('https://example.net', [])).toEqual([])
  })

  test('returns nothing for an unusable page url', () => {
    expect(findMatches('about:blank', [gitlab])).toEqual([])
    expect(findMatches('', [gitlab])).toEqual([])
  })

  test('is case insensitive on the page hostname', () => {
    expect(findMatches('https://GitLab.Example.NET', [gitlab])).toHaveLength(1)
  })

  test('does not mutate the index it is given', () => {
    const index = [wiki, gitlab, apex]
    const snapshot = [...index]

    findMatches('https://gitlab.example.net', index)
    expect(index).toEqual(snapshot)
  })
})
