import { describe, expect, test, vi } from 'vitest'
import { classifySender, parseRequest, route } from './router'
import { ServiceError } from './errors'
import type { BackgroundService } from './service'
import type { Sender } from './router'

const page: Sender = { id: 'ext-id', url: 'chrome-extension://ext-id/popup.html' }
const firefoxPage: Sender = { id: 'ext-id', origin: 'chrome-extension://ext-id' }
const content: Sender = {
  id: 'ext-id',
  url: 'https://gitlab.example.net/users/sign_in',
  origin: 'https://gitlab.example.net',
  tab: { id: 7 },
  frameId: 2,
}

function deps() {
  const service = {
    status: vi.fn(async () => ({ configured: true, unlocked: false, address: 'https://v', index: {} })),
    probe: vi.fn(async () => ({ sealed: false })),
    saveConfig: vi.fn(async () => 'saved'),
    login: vi.fn(async () => 'in'),
    logout: vi.fn(async () => undefined),
    lock: vi.fn(async () => undefined),
    refreshIndex: vi.fn(async () => ({ entries: [1, 2], problems: [3], builtAt: 5 })),
    matches: vi.fn(async () => 'matches'),
    fill: vi.fn(async () => 'filled'),
  }
  const tabs = new Map([[9, 'https://tab.example.net/login']])
  return {
    service,
    deps: {
      service: service as unknown as BackgroundService,
      runtimeId: 'ext-id',
      extensionOrigin: 'chrome-extension://ext-id',
      tabUrl: async (id: number) => tabs.get(id),
    },
  }
}

describe('classifySender', () => {
  const d = { runtimeId: 'ext-id', extensionOrigin: 'chrome-extension://ext-id' }

  test.each([
    [page, 'page'],
    [firefoxPage, 'page'],
    [content, 'content'],
  ] as const)('%j → %s', (sender, expected) => {
    expect(classifySender(d, sender)).toBe(expected)
  })

  test.each([
    [{ ...page, id: 'other-ext' }],
    [{ url: page.url }],
    [{ id: 'ext-id' }],
    [{ id: 'ext-id', url: 'https://x.net/' }],
    [{ id: 'ext-id', url: 'chrome-extension://ext-id.evil/x' }],
    [{ id: 'ext-id', origin: 'https://x.net', url: 'chrome-extension://ext-id/popup.html' }],
    // A page pretending to be us through a spoofed URL but no tab.
    [{ id: 'ext-id', url: 'https://chrome-extension.example/' }],
  ])('rejects %j', (sender) => {
    expect(() => classifySender(d, sender)).toThrow(ServiceError)
  })
})

describe('route', () => {
  test('status: full for pages, reduced for content scripts', async () => {
    const { deps: d } = deps()
    expect(await route(d, { type: 'status' }, page)).toMatchObject({ ok: true, value: { address: 'https://v' } })
    expect(await route(d, { type: 'status' }, content)).toEqual({
      ok: true,
      value: { configured: true, unlocked: false },
    })
  })

  test('page-only requests', async () => {
    const { deps: d, service } = deps()
    await route(d, { type: 'probe', address: 'https://v', namespace: 'ns' }, page)
    expect(service.probe).toHaveBeenCalledWith('https://v', 'ns')
    await route(d, { type: 'probe', address: 'https://v' }, page)
    expect(service.probe).toHaveBeenLastCalledWith('https://v', undefined)
    await route(d, { type: 'config/save', config: { a: 1 } }, page)
    expect(service.saveConfig).toHaveBeenCalledWith({ a: 1 })
    await route(d, { type: 'logout' }, page)
    await route(d, { type: 'lock' }, page)
    expect(service.lock).toHaveBeenCalledWith('user')
    expect(await route(d, { type: 'index/refresh' }, page)).toEqual({
      ok: true,
      value: { count: 2, problems: 1, builtAt: 5 },
    })

    for (const type of ['probe', 'config/save', 'login', 'logout', 'lock', 'index/refresh', 'matches/tab']) {
      const response = await route(d, { type, address: 'x', tabId: 1, input: { method: 'oidc' } }, content)
      expect(response).toMatchObject({ ok: false, error: { kind: 'forbidden_sender' } })
    }
    expect(service.logout).toHaveBeenCalledTimes(1)
  })

  test('login inputs', async () => {
    const { deps: d, service } = deps()
    const inputs = [
      { method: 'token', token: 't' },
      { method: 'userpass', password: 'p' },
      { method: 'ldap', password: 'p' },
      { method: 'approle', secretId: 's' },
      { method: 'oidc' },
    ]
    for (const input of inputs) {
      expect(await route(d, { type: 'login', input }, page)).toEqual({ ok: true, value: 'in' })
    }
    await route(d, { type: 'login', input: { method: 'approle' } }, page)
    expect(service.login).toHaveBeenLastCalledWith({ method: 'approle', secretId: '' })
  })

  test('matches use browser-provided URLs only', async () => {
    const { deps: d, service } = deps()
    await route(d, { type: 'matches/tab', tabId: 9, url: 'https://evil/' }, page)
    expect(service.matches).toHaveBeenLastCalledWith('https://tab.example.net/login', true)

    await route(d, { type: 'matches/frame', userAction: true, url: 'https://evil/' }, content)
    expect(service.matches).toHaveBeenLastCalledWith('https://gitlab.example.net/users/sign_in', true)
    await route(d, { type: 'matches/frame', userAction: 'yes' }, content)
    expect(service.matches).toHaveBeenLastCalledWith('https://gitlab.example.net/users/sign_in', false)

    expect(await route(d, { type: 'matches/tab', tabId: 404 }, page)).toMatchObject({
      ok: false,
      error: { kind: 'unsupported_page' },
    })
    expect(await route(d, { type: 'matches/frame', userAction: true }, page)).toMatchObject({
      ok: false,
      error: { kind: 'forbidden_sender' },
    })
  })

  test('fill from a content script targets the sending frame', async () => {
    const { deps: d, service } = deps()
    const response = await route(
      d,
      { type: 'fill', mount: 'secret', path: 'gitlab', allowDowngrade: true, tabId: 99, frameUrl: 'https://evil/' },
      content,
    )
    expect(response).toEqual({ ok: true, value: 'filled' })
    expect(service.fill).toHaveBeenCalledWith({
      tabId: 7,
      frameId: 2,
      frameUrl: 'https://gitlab.example.net/users/sign_in',
      mount: 'secret',
      path: 'gitlab',
      allowDowngrade: true,
    })

    await route(d, { type: 'fill', mount: 'm', path: 'p' }, { ...content, frameId: undefined })
    expect(service.fill).toHaveBeenLastCalledWith(expect.objectContaining({ frameId: 0, allowDowngrade: false }))
  })

  test('fill from a page targets the top frame of the given tab', async () => {
    const { deps: d, service } = deps()
    await route(d, { type: 'fill', mount: 'm', path: 'p', tabId: 9 }, page)
    expect(service.fill).toHaveBeenLastCalledWith(
      expect.objectContaining({ tabId: 9, frameId: 0, frameUrl: 'https://tab.example.net/login' }),
    )
    expect(await route(d, { type: 'fill', mount: 'm', path: 'p' }, page)).toMatchObject({
      ok: false,
      error: { kind: 'bad_request' },
    })
  })

  test('service errors are reduced to kind and message', async () => {
    const { deps: d, service } = deps()
    service.status.mockRejectedValueOnce(new ServiceError('locked', 'Unlock first'))
    expect(await route(d, { type: 'status' }, page)).toEqual({
      ok: false,
      error: { kind: 'locked', message: 'Unlock first' },
    })
    service.status.mockRejectedValueOnce(new Error('secret stack'))
    expect(await route(d, { type: 'status' }, page)).toEqual({
      ok: false,
      error: { kind: 'internal', message: 'Unexpected error' },
    })
  })

  test('unknown senders never reach the service', async () => {
    const { deps: d, service } = deps()
    expect(await route(d, { type: 'status' }, { id: 'intruder' })).toMatchObject({
      ok: false,
      error: { kind: 'forbidden_sender' },
    })
    expect(service.status).not.toHaveBeenCalled()
  })
})

describe('parseRequest', () => {
  test.each([
    null,
    'status',
    [],
    {},
    { type: 'nope' },
    { type: 'probe' },
    { type: 'probe', address: 'x', namespace: 1 },
    { type: 'login' },
    { type: 'login', input: { method: 'kerberos' } },
    { type: 'login', input: { method: 'token' } },
    { type: 'login', input: { method: 'approle', secretId: 1 } },
    { type: 'matches/tab', tabId: -1 },
    { type: 'matches/tab', tabId: 1.5 },
    { type: 'matches/tab', tabId: '1' },
    { type: 'fill', mount: 'm' },
    { type: 'fill', mount: 'm', path: 'p', tabId: 'x' },
  ])('rejects %j', (message) => {
    expect(() => parseRequest(message)).toThrow('Malformed message')
  })
})
