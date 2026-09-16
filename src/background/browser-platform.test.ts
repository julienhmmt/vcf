import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'

vi.mock('wxt/browser', () => ({ browser: fakeBrowser }))
vi.stubGlobal('location', { origin: 'chrome-extension://test-extension-id' })

const { browserPlatform } = await import('./browser-platform')
const { default: background } = await import('../entrypoints/background')

type Mutable = Record<string, unknown>

beforeEach(() => {
  fakeBrowser.reset()
  delete (fakeBrowser as unknown as Mutable).identity
})

describe('browserPlatform', () => {
  test('storage areas', async () => {
    const platform = browserPlatform()
    await platform.session.set('k', { a: 1 })
    expect(await platform.session.get('k')).toEqual({ a: 1 })
    expect(await fakeBrowser.storage.local.get('k')).toEqual({})
    await platform.session.remove('k')
    expect(await platform.session.get('k')).toBeUndefined()
    await platform.local.set('x', 2)
    expect(await fakeBrowser.storage.local.get('x')).toEqual({ x: 2 })
  })

  test('alarms', async () => {
    const platform = browserPlatform()
    await platform.alarms.create('a', { periodInMinutes: 5 })
    expect(await fakeBrowser.alarms.get('a')).toMatchObject({ name: 'a', periodInMinutes: 5 })
    await platform.alarms.clear('a')
    expect(await fakeBrowser.alarms.get('a')).toBeUndefined()
  })

  test('identity, clock and origin', () => {
    const platform = browserPlatform()
    expect(platform.runtimeId).toBe(fakeBrowser.runtime.id)
    expect(platform.extensionOrigin).toBe('chrome-extension://test-extension-id')
    expect(Math.abs(platform.now() - Date.now())).toBeLessThan(1000)
    expect(platform.fetch).toBeUndefined()
  })

  test('host permission uses the origin pattern', async () => {
    const contains = vi.fn(async () => true)
    fakeBrowser.permissions.contains = contains as never
    expect(await browserPlatform().hasHostPermission('https://vault.example.net:8200/x')).toBe(true)
    expect(contains).toHaveBeenCalledWith({ origins: ['https://vault.example.net:8200/*'] })
  })

  test('tab URL, undefined when the tab is gone', async () => {
    const tab = await fakeBrowser.tabs.create({ url: 'https://example.net/login' })
    const platform = browserPlatform()
    expect(await platform.tabUrl(tab.id!)).toBe('https://example.net/login')
    expect(await platform.tabUrl(424242)).toBeUndefined()
  })

  test('fill goes to one frame', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    fakeBrowser.tabs.sendMessage = send as never
    const payload = { type: 'vcf/fill', username: 'u', password: 'p', totp: null } as const
    await browserPlatform().sendToFrame(3, 5, payload)
    expect(send).toHaveBeenCalledWith(3, payload, { frameId: 5 })
  })

  test('keep-alive pings the runtime', async () => {
    const ping = vi.fn(async () => ({}))
    fakeBrowser.runtime.getPlatformInfo = ping as never
    await browserPlatform().keepAlive()
    expect(ping).toHaveBeenCalled()
  })

  test('OIDC needs the identity permission', async () => {
    const platform = browserPlatform()
    expect(() => platform.oidcRedirectUri()).toThrow('identity permission')
    await expect(platform.launchWebAuthFlow('https://idp')).rejects.toThrow('identity permission')

    const launch = vi.fn(async () => 'https://cb?code=1')
    ;(fakeBrowser as unknown as Mutable).identity = {
      launchWebAuthFlow: launch,
      getRedirectURL: (path: string) => `https://id.chromiumapp.org/${path}`,
    }
    expect(platform.oidcRedirectUri()).toBe('https://id.chromiumapp.org/oidc')
    expect(await platform.launchWebAuthFlow('https://idp')).toBe('https://cb?code=1')
    expect(launch).toHaveBeenCalledWith({ url: 'https://idp', interactive: true })

    launch.mockResolvedValueOnce(undefined as never)
    await expect(platform.launchWebAuthFlow('https://idp')).rejects.toThrow('closed')
  })
})

describe('background entrypoint', () => {
  test('wires messages, alarms and lifecycle synchronously', async () => {
    background.main()

    const reply = await new Promise((resolve) => {
      const keepOpen = fakeBrowser.runtime.onMessage.trigger(
        { type: 'status' },
        { id: fakeBrowser.runtime.id, url: 'chrome-extension://test-extension-id/popup.html' },
        resolve,
      )
      void keepOpen
    })
    expect(reply).toMatchObject({ ok: true, value: { configured: false } })

    await fakeBrowser.alarms.onAlarm.trigger({ name: 'vcf:refresh', scheduledTime: 0 } as never)
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' } as never)
    await fakeBrowser.runtime.onStartup.trigger()
    // Nothing configured: reconcile leaves no alarm behind.
    await vi.waitFor(async () => expect(await fakeBrowser.alarms.getAll()).toEqual([]))
  })
})
