import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// See .claude/skills/autofill-content-script's Testing section: shadow
// DOM and framework-controlled fields need a real browser, not jsdom.
// build-fixture.mjs bundles the exact src/content/detect.ts +
// inject.ts into fixtures/vcf-content-core.js, so this exercises the
// same code the extension ships, not a re-implementation.

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function fixture(name: string): string {
  return `file://${path.resolve(__dirname, 'fixtures', name)}`
}

interface DetectSummary {
  readonly formsCount: number
  readonly usernameId: string | null
}

async function detectAndFill(target: Page | ReturnType<Page['frame']>, username: string, password: string): Promise<DetectSummary> {
  if (!target) throw new Error('target frame not found')
  return target.evaluate(({ username, password }) => {
    const forms = window.VCF!.detectLoginForms()
    const form = forms[0]
    if (form) window.VCF!.fillLoginForm(form, { username, password, totp: null })
    return { formsCount: forms.length, usernameId: form?.usernameEl?.id ?? null }
  }, { username, password })
}

test('detects and fills a form inside an open shadow root', async ({ page }) => {
  await page.goto(fixture('shadow-dom.html'))

  const summary = await detectAndFill(page, 'julien', 'hunter2')
  expect(summary).toEqual({ formsCount: 1, usernameId: 'user' })

  // #user/#pw live inside a shadow root — Playwright's locators pierce
  // it the same way a real user's inspection would.
  await expect(page.locator('#user')).toHaveValue('julien')
  await expect(page.locator('#pw')).toHaveValue('hunter2')
})

test('detects and fills a form inside a same-origin iframe, not the top frame', async ({ page }) => {
  await page.goto(fixture('iframe-host.html'))
  const frame = page.frame({ url: /iframe-form\.html/ })
  expect(frame).not.toBeNull()

  // The top frame has no password field at all — matching how
  // `all_frames: true` gives the iframe its own content-script
  // instance rather than the parent reaching into it.
  const topSummary = await page.evaluate(() => window.VCF!.detectLoginForms())
  expect(topSummary).toHaveLength(0)

  const summary = await detectAndFill(frame, 'julien', 'hunter2')
  expect(summary).toEqual({ formsCount: 1, usernameId: 'user' })
  await expect(frame!.locator('#user')).toHaveValue('julien')
  await expect(frame!.locator('#pw')).toHaveValue('hunter2')
})

test('fills a real React-controlled form and React itself notices', async ({ page }) => {
  await page.goto(fixture('react.html'))

  const summary = await detectAndFill(page, 'julien', 'hunter2')
  expect(summary).toEqual({ formsCount: 1, usernameId: 'user' })

  await expect(page.locator('#user')).toHaveValue('julien')
  await expect(page.locator('#pw')).toHaveValue('hunter2')
  // #mirror is rendered from React's *own* state, updated only by its
  // onChange handler — this is what proves setNativeValue's
  // prototype-setter-then-dispatch approach actually defeats React's
  // instance-level value tracking rather than just changing the DOM
  // value underneath it unnoticed (see src/content/inject.ts's
  // top-of-file comment).
  await expect(page.locator('#mirror')).toHaveText('julien:hunter2')
})
