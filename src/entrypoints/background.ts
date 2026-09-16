import { defineBackground } from 'wxt/utils/define-background'
import { browser } from 'wxt/browser'
import { browserPlatform } from '../background/browser-platform'
import { route } from '../background/router'
import { BackgroundService } from '../background/service'

export default defineBackground({
  type: 'module',
  main() {
    const platform = browserPlatform()
    const service = new BackgroundService(platform)
    const deps = {
      service,
      runtimeId: platform.runtimeId,
      extensionOrigin: platform.extensionOrigin,
      tabUrl: (tabId: number) => platform.tabUrl(tabId),
    }

    // Listeners are registered synchronously, on the first tick:
    // Chrome only wakes the worker for listeners present then.
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      void route(deps, message, sender).then(sendResponse)
      return true
    })

    browser.alarms.onAlarm.addListener((alarm) => {
      void service.onAlarm(alarm.name).catch(() => undefined)
    })

    browser.runtime.onInstalled.addListener(() => {
      void service.reconcile().catch(() => undefined)
    })

    browser.runtime.onStartup.addListener(() => {
      void service.reconcile().catch(() => undefined)
    })

    // Anything not listed above must never be wired: in particular no
    // onMessageExternal, there is no legitimate external caller.
  },
})
