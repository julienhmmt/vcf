import { defineContentScript } from 'wxt/utils/define-content-script'
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'
import { browser } from 'wxt/browser'
import { BadgeController } from '../content/badge'
import { fillLoginForm } from '../content/inject'
import { contentRpc } from '../content/rpc'
import { watchForLoginForms } from '../content/watch'
import type { ContentScriptContext } from 'wxt/utils/content-script-context'
import type { LoginFormFields } from '../content/detect'
import type { FillPayload } from '../background/platform'

const BADGE_CSS = `
  :host { all: initial; }
  .vcf-toggle {
    font-size: 14px;
    line-height: 1;
    padding: 2px 4px;
    border: 1px solid light-dark(#ccc, #555);
    border-radius: 4px;
    background: light-dark(#fff, #222);
    cursor: pointer;
  }
  .vcf-panel {
    position: absolute;
    z-index: 2147483647;
    margin-top: 2px;
    min-width: 200px;
    max-width: 280px;
    padding: 8px;
    border: 1px solid light-dark(#ccc, #555);
    border-radius: 6px;
    background: light-dark(#fff, #222);
    color: light-dark(#111, #eee);
    font: 12px system-ui, sans-serif;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }
  .vcf-panel ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .vcf-panel li { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .vcf-panel button { cursor: pointer; }
  .vcf-panel [role='alert'] { color: #c0392b; }
  .vcf-downgrade { margin-top: 6px; padding: 6px; border-radius: 4px; background: light-dark(#fdf3e7, #4a3a1a); }
  .vcf-downgrade p { margin: 0 0 4px; }
`

interface MountedBadge {
  readonly form: LoginFormFields
  readonly ui: { remove(): void }
  readonly badge: BadgeController
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  cssInjectionMode: 'ui',

  async main(ctx) {
    let forms: LoginFormFields[] = []
    let activeForm: LoginFormFields | null = null
    // Keyed by the password element itself, so a re-scan triggered by
    // unrelated DOM churn elsewhere on the page (ads, widgets — very
    // common) doesn't tear down and rebuild every badge, which would
    // yank an open candidate list out from under the user mid-click.
    const mounted = new Map<HTMLInputElement, MountedBadge>()

    // Delivered by the worker after a successful `fill`, from either
    // this frame's own badge or the popup filling the top frame.
    // Secret values live here only for the synchronous span of this
    // handler.
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!isFillPayload(message)) return
      const target = activeForm ?? forms[0]
      if (target) fillLoginForm(target, message)
    })

    const stopWatching = watchForLoginForms(
      (detected) => {
        forms = detected
        const detectedKeys = new Set(detected.map((form) => form.passwordEl))

        for (const [key, entry] of mounted) {
          if (detectedKeys.has(key)) continue
          entry.badge.destroy()
          entry.ui.remove()
          mounted.delete(key)
          if (activeForm === entry.form) activeForm = null
        }

        for (const form of detected) {
          if (!mounted.has(form.passwordEl)) void mountBadgeIfMatched(ctx, form)
        }
      },
      { root: document, target: document.body },
    )

    async function mountBadgeIfMatched(context: ContentScriptContext, form: LoginFormFields): Promise<void> {
      // Passive: this is `userAction: false` precisely so a page load
      // never counts as activity (see docs/messaging.md).
      let hasCandidates = false
      try {
        const result = await contentRpc.matchesForFrame(false)
        hasCandidates = result.unlocked && result.candidates.length > 0
      } catch {
        return
      }
      // The form may have been removed, or already got a badge from
      // a concurrent scan, while that request was in flight.
      if (!hasCandidates || mounted.has(form.passwordEl)) return

      const ui = await createShadowRootUi(context, {
        name: 'vcf-badge',
        position: 'inline',
        anchor: form.usernameEl ?? form.passwordEl,
        append: 'after',
        css: BADGE_CSS,
        onMount: (container) =>
          new BadgeController(container, {
            listCandidates: async () => (await contentRpc.matchesForFrame(true)).candidates,
            fill: async (candidate, allowDowngrade) => {
              activeForm = form
              await contentRpc.fill({ mount: candidate.mount, path: candidate.path, allowDowngrade })
            },
          }),
      })
      ui.mount()
      const badge = ui.mounted
      if (badge) mounted.set(form.passwordEl, { form, ui, badge })
    }

    ctx.onInvalidated(() => {
      stopWatching()
      for (const entry of mounted.values()) {
        entry.badge.destroy()
        entry.ui.remove()
      }
      mounted.clear()
    })
  },
})

function isFillPayload(message: unknown): message is FillPayload {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'vcf/fill'
}
