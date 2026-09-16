import type { AlarmSpec, FillPayload, Platform, StorageArea } from './platform'
import type { FetchLike } from '../vault/http'

export interface FakePlatform extends Platform {
  clock: number
  readonly sessionData: Map<string, unknown>
  readonly localData: Map<string, unknown>
  readonly alarmTable: Map<string, AlarmSpec>
  readonly delivered: Array<{ tabId: number; frameId: number; payload: FillPayload }>
  readonly tabs: Map<number, string>
  granted: boolean
  receiverMissing: boolean
  authFlow: (url: string) => Promise<string>
  identityGranted: boolean
  keepAlives: number
}

export function fakePlatform(fetch?: FetchLike): FakePlatform {
  const sessionData = new Map<string, unknown>()
  const localData = new Map<string, unknown>()
  const alarmTable = new Map<string, AlarmSpec>()

  const platform: FakePlatform = {
    clock: 1_000_000,
    sessionData,
    localData,
    alarmTable,
    delivered: [],
    tabs: new Map(),
    granted: true,
    receiverMissing: false,
    identityGranted: true,
    keepAlives: 0,
    authFlow: async () => {
      throw new Error('no auth flow configured')
    },
    session: area(sessionData),
    local: area(localData),
    alarms: {
      async create(name, spec) {
        alarmTable.set(name, spec)
      },
      async clear(name) {
        alarmTable.delete(name)
      },
    },
    runtimeId: 'ext-id',
    extensionOrigin: 'chrome-extension://ext-id',
    now: () => platform.clock,
    hasHostPermission: async () => platform.granted,
    tabUrl: async (tabId) => platform.tabs.get(tabId),
    async sendToFrame(tabId, frameId, payload) {
      if (platform.receiverMissing) throw new Error('Could not establish connection')
      platform.delivered.push({ tabId, frameId, payload })
      return { ok: true }
    },
    launchWebAuthFlow: (url) => platform.authFlow(url),
    oidcRedirectUri() {
      if (!platform.identityGranted) throw new Error('identity missing')
      return 'https://ext-id.chromiumapp.org/oidc'
    },
    async keepAlive() {
      platform.keepAlives++
    },
    ...(fetch ? { fetch } : {}),
  }
  return platform
}

/** Round-trips through JSON, like the real storage does. */
function area(data: Map<string, unknown>): StorageArea {
  return {
    async get<T>(key: string) {
      const raw = data.get(key)
      return raw === undefined ? undefined : (JSON.parse(JSON.stringify(raw)) as T)
    },
    async set(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)))
    },
    async remove(key) {
      data.delete(key)
    },
  }
}
