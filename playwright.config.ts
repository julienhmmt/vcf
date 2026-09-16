import { defineConfig } from '@playwright/test'

/**
 * Real-browser verification for src/content/ — jsdom can fake shadow
 * DOM and MutationObserver well enough, but not framework-controlled
 * inputs (see src/content/inject.test.ts's own comment) or cross-
 * frame boundaries. These fixtures load the actual detect/inject
 * code (bundled by test/e2e/build-fixture.mjs) into real pages.
 */
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: undefined,
  },
})
