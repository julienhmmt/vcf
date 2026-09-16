// Bundles the (pure, framework-agnostic) detect/inject logic into a
// plain script the fixture pages can load with <script src>, so the
// same code exercised by the jsdom unit tests also runs here under a
// real browser engine. Run before `playwright test` (see package.json
// "pretest:e2e").
import { build } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

await build({
  root: __dirname,
  logLevel: 'warn',
  build: {
    lib: {
      entry: path.resolve(__dirname, 'entry.ts'),
      name: 'VCF',
      formats: ['iife'],
      fileName: () => 'vcf-content-core.js',
    },
    outDir: path.resolve(__dirname, 'fixtures'),
    emptyOutDir: false,
    minify: false,
  },
})
