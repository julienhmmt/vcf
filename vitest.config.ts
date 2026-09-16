import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

// Two projects so `.svelte` files and the DOM only cost anything for
// the UI tests that need them; everything else keeps running under
// plain Node with no browser resolve conditions.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.svelte'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test-helper.ts',
        'src/**/index.ts',
        'src/background/platform.ts',
        'src/entrypoints/**',
        'src/ui/**/main.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // Component tests are named `*.svelte.test.ts` wherever they
          // live (src/ui, src/entrypoints/*) and belong to the ui
          // project below instead.
          exclude: ['**/*.svelte.test.ts'],
        },
      },
      {
        plugins: [svelte({ compilerOptions: { hmr: false } })],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['src/**/*.svelte.test.ts'],
          setupFiles: ['src/ui/test-setup.ts'],
        },
      },
    ],
  },
})
