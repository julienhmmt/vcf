import { browser } from 'wxt/browser'
import { hostPattern } from './config'
import { ServiceError } from './errors'
import type { Browser } from 'wxt/browser'
import type { FillPayload, Platform, StorageArea } from './platform'

/**
 * The one place that talks to the real extension APIs. Deliberately
 * thin: anything with logic belongs in the service, where it is tested.
 */
export function browserPlatform(): Platform {
  return {
    session: area(browser.storage.session),
    local: area(browser.storage.local),
    alarms: {
      async create(name, spec) {
        await browser.alarms.create(name, { ...spec })
      },
      async clear(name) {
        await browser.alarms.clear(name)
      },
    },
    runtimeId: browser.runtime.id,
    // Inside the worker, our own origin is simply where we run.
    extensionOrigin: globalThis.location.origin,
    now: () => Date.now(),
    hasHostPermission: (address) => browser.permissions.contains({ origins: [hostPattern(address)] }),
    async tabUrl(tabId) {
      try {
        return (await browser.tabs.get(tabId)).url
      } catch {
        return undefined
      }
    },
    sendToFrame: (tabId: number, frameId: number, payload: FillPayload) =>
      browser.tabs.sendMessage(tabId, payload, { frameId }),
    async launchWebAuthFlow(url) {
      const identity = identityApi()
      const redirected = await identity.launchWebAuthFlow({ url, interactive: true })
      if (!redirected) throw new ServiceError('bad_request', 'Sign-in window was closed')
      return redirected
    },
    oidcRedirectUri: () => identityApi().getRedirectURL('oidc'),
    async keepAlive() {
      await browser.runtime.getPlatformInfo()
    },
  }
}

/** `identity` is an optional permission, requested when OIDC is chosen. */
function identityApi(): typeof Browser.identity {
  const identity = (browser as { identity?: typeof Browser.identity }).identity
  if (identity === undefined) {
    throw new ServiceError('bad_request', 'The identity permission is required for OIDC')
  }
  return identity
}

function area(storage: Browser.storage.StorageArea): StorageArea {
  return {
    async get<T>(key: string) {
      const result = await storage.get(key)
      return result[key] as T | undefined
    },
    set: (key, value) => storage.set({ [key]: value }),
    remove: (key) => storage.remove(key),
  }
}
