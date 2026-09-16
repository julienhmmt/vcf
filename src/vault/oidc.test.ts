import { describe, expect, test } from 'vitest'
import { VaultHttp } from './http'
import { loginOidc, parseOidcRedirect } from './oidc'
import { authReply, fakeVault } from './fake-server.test-helper'

const redirectUri = 'https://abc.chromiumapp.org/oidc'
const idp = 'https://idp.example.net/authorize?client_id=vault&state=st-1&nonce=n'

function setup(authUrl = idp, warnings: string[] | null = null) {
  const { fetch, calls } = fakeVault({
    'POST auth/oidc/oidc/auth_url': { body: { data: { auth_url: authUrl }, warnings } },
    'GET auth/oidc/oidc/callback': authReply('s.oidc'),
  })
  return { ctx: { http: new VaultHttp({ address: 'http://v', fetch }), now: () => 1 }, calls }
}

describe('loginOidc', () => {
  test('runs the whole round trip', async () => {
    const { ctx, calls } = setup()
    const opened: string[] = []

    const session = await loginOidc(ctx, {
      role: 'vcf',
      redirectUri,
      randomNonce: () => 'nonce-1',
      openAuthWindow: async (url) => {
        opened.push(url)
        return `${redirectUri}?code=c-1&state=st-1`
      },
    })

    expect(opened).toEqual([idp])
    expect(calls[0]?.body).toEqual({ role: 'vcf', redirect_uri: redirectUri, client_nonce: 'nonce-1' })
    expect(Object.fromEntries(calls[1]?.query ?? [])).toEqual({
      state: 'st-1',
      code: 'c-1',
      client_nonce: 'nonce-1',
    })
    expect(session).toMatchObject({ token: 's.oidc', method: 'oidc', observedAt: 1 })
  })

  test('default role and random nonce', async () => {
    const { ctx, calls } = setup()
    await loginOidc(ctx, {
      redirectUri,
      openAuthWindow: async () => `${redirectUri}#code=c&state=st-1`,
    })
    const body = calls[0]?.body as Record<string, string>
    expect(body).not.toHaveProperty('role')
    expect(body.client_nonce).toMatch(/^[0-9a-f]{40}$/)
  })

  test('explains an empty auth_url', async () => {
    const { ctx } = setup('', ['redirect_uri not allowed'])
    await expect(
      loginOidc(ctx, { redirectUri, openAuthWindow: async () => '' }),
    ).rejects.toThrow('redirect_uri not allowed')

    const bare = setup('')
    await expect(
      loginOidc(bare.ctx, { redirectUri, openAuthWindow: async () => '' }),
    ).rejects.toThrow('allowed_redirect_uris')
  })

  test('refuses a state mismatch', async () => {
    const { ctx, calls } = setup()
    await expect(
      loginOidc(ctx, { redirectUri, openAuthWindow: async () => `${redirectUri}?code=c&state=forged` }),
    ).rejects.toThrow('state mismatch')
    expect(calls).toHaveLength(1)
  })
})

describe('parseOidcRedirect', () => {
  test('query and fragment', () => {
    expect(parseOidcRedirect(`${redirectUri}?code=a&state=b`, redirectUri)).toEqual({ code: 'a', state: 'b' })
    expect(parseOidcRedirect(`${redirectUri}#code=a&state=b`, redirectUri)).toEqual({ code: 'a', state: 'b' })
  })

  test.each([
    ['not a url', 'not a URL'],
    ['https://evil.example/oidc?code=a&state=b', 'unexpected URL'],
    [`${redirectUri}/x?code=a&state=b`, 'unexpected URL'],
    [`${redirectUri}?error=access_denied&error_description=User+said+no`, 'User said no'],
    [`${redirectUri}?error=access_denied`, 'access_denied'],
    [`${redirectUri}?code=a`, 'lacks code or state'],
  ])('%s', (url, message) => {
    expect(() => parseOidcRedirect(url, redirectUri)).toThrow(message)
  })
})
