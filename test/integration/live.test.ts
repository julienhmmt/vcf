/**
 * End-to-end checks of the Vault client against real servers seeded
 * by dev/seed/seed.sh.
 *
 * Targets come from VCF_TARGETS, `name=url` pairs separated by commas.
 * Default: both servers of the dev compose file.
 */
import { beforeAll, describe, expect, test } from 'vitest'
import { VaultClient, buildIndex, isVaultError } from '../../src/vault'
import { findMatches } from '../../src/core/matcher'
import type { SessionClient } from '../../src/vault'
import { MatchQuality } from '../../src/core/types'
import type { IndexEntry } from '../../src/core/types'

const targets = (process.env.VCF_TARGETS ?? 'vault=http://127.0.0.1:8200,openbao=http://127.0.0.1:8300')
  .split(',')
  .map((pair) => pair.split('=') as [string, string])

describe.each(targets)('%s', (_name, address) => {
  const vault = new VaultClient({ address })

  test('health', async () => {
    const health = await vault.health()
    expect(health).toMatchObject({ initialized: true, sealed: false })
    expect(health.version).not.toBe('')
  })

  describe('auth', () => {
    test('token', async () => {
      const client = await vault.withToken('vcf-token')
      expect(client.session.policies).toContain('vcf-filler')
      expect(client.session.renewable).toBe(true)
    })

    test('bad token', async () => {
      await expect(vault.withToken('nope')).rejects.toMatchObject({ kind: 'unauthenticated' })
    })

    test('userpass, renew, revoke', async () => {
      const client = await vault.withUserpass({ username: 'vcf', password: 'vcf' })
      expect(client.session).toMatchObject({ method: 'userpass', renewable: true })
      expect(client.session.ttl).toBeGreaterThan(3000)

      const renewed = await client.renew()
      expect(renewed.token).toBe(client.session.token)
      expect(renewed.ttl).toBeGreaterThan(3000)

      await client.logout()
      await expect(client.verify()).rejects.toMatchObject({ kind: 'unauthenticated' })
    })

    test('bad password', async () => {
      await expect(vault.withUserpass({ username: 'vcf', password: 'wrong' })).rejects.toMatchObject({
        kind: 'invalid',
      })
    })

    test('approle', async () => {
      const client = await vault.withApprole({ roleId: 'vcf-role', secretId: 'vcf-secret' })
      expect(client.session.policies).toContain('vcf-filler')
      await client.logout()
    })
  })

  describe('filler policy', () => {
    let client: SessionClient
    let entries: IndexEntry[]

    beforeAll(async () => {
      client = await vault.withUserpass({ username: 'vcf', password: 'vcf' })
      const mounts = await client.kvMounts()
      const index = await client.buildIndex(mounts)
      entries = index.entries
    })

    test('sees the three kv mounts with their versions', async () => {
      const mounts = await client.kvMounts()
      expect(mounts.map((m) => [m.path, m.version])).toEqual([
        ['legacy', 1],
        ['secret', 2],
        ['team', 2],
      ])
    })

    test('index content', () => {
      expect(entries.map((e) => `${e.mount}:${e.path}`).sort()).toEqual([
        'legacy:sites/example.org',
        'secret:perso/deleted',
        'secret:perso/github.com',
        'secret:perso/gitlab',
        'secret:perso/infra/proxmox',
        'secret:perso/jira',
        'secret:perso/local-test',
        'secret:perso/mail',
        'secret:perso/nextcloud-admin',
        'secret:perso/nextcloud-user',
        'team:shared/wiki',
        'secret:pro/grafana',
      ].sort())
    })

    test('matching on real entries', () => {
      // Host-level and better; domain-level matches are listed after them.
      const best = (url: string) =>
        findMatches(url, entries)
          .filter((m) => m.quality >= MatchQuality.Subdomain)
          .map((m) => m.entry.title)
      expect(best('https://git.example.net/users/sign_in')).toEqual(['GitLab interne'])
      expect(best('https://cloud.example.net/login')).toEqual(['Nextcloud (admin)', 'Nextcloud (julien)'])
      expect(best('https://tools.example.net/jira/login')).toEqual(['Jira'])
      expect(best('https://tools.example.net/other')).toEqual([])
      expect(best('https://www.example.org/')).toEqual(['example.org'])
      expect(best('https://pve.example.net:8006/')).toEqual(['proxmox'])
      expect(findMatches('https://intranet/', entries)).toEqual([])

      const all = findMatches('https://git.example.net/', entries)
      expect(all[0]?.quality).toBe(MatchQuality.Host)
      expect(all.at(-1)?.quality).toBe(MatchQuality.Domain)
    })

    test('reads credentials with declared and default keys', async () => {
      const read = (path: string) => client.readCredential(entries.find((e) => e.path === path)!)

      expect(await read('perso/gitlab')).toEqual({ username: 'julien', password: 'gitlab-pass', totpSeed: null })
      expect(await read('perso/jira')).toMatchObject({ username: 'jdoe', password: 'jira-pass' })
      expect(await read('perso/mail')).toEqual({
        username: 'julien@example.net',
        password: 'mail-pass',
        totpSeed: 'JBSWY3DPEHPK3PXP',
      })
      expect(await read('shared/wiki')).toMatchObject({ username: 'team', password: 'wiki-pass' })
      expect(await read('sites/example.org')).toMatchObject({ username: 'legacy', password: 'legacy-pass' })
    })

    test('indexed but not readable', async () => {
      const grafana = entries.find((e) => e.path === 'pro/grafana')!
      const error = await client.readCredential(grafana).catch((e: unknown) => e)
      expect(isVaultError(error, 'permission')).toBe(true)
    })

    test('soft-deleted secret', async () => {
      const deleted = entries.find((e) => e.path === 'perso/deleted')!
      await expect(client.readCredential(deleted)).rejects.toMatchObject({ kind: 'not_found' })
    })
  })

  describe('scoped policy', () => {
    test('index limited to perso/, other mounts hidden', async () => {
      const client = await vault.withUserpass({ username: 'scoped', password: 'scoped' })
      const mounts = await client.kvMounts()
      expect(mounts.map((m) => m.path)).toEqual(['secret'])

      const index = await client.buildIndex(mounts)
      expect(index.entries.every((e) => e.path.startsWith('perso/'))).toBe(true)
      expect(index.entries).toHaveLength(9)
      expect(index.problems).toEqual([])

      // Without the ACL hint, a walk from the mount root is denied.
      const blind = await buildIndex(client.kv(mounts[0]!))
      expect(blind.entries).toEqual([])
      expect(blind.problems.map((p) => [p.path, p.error.kind])).toEqual([['', 'permission']])
    })
  })
})
