import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/svelte'
import '@testing-library/jest-dom/vitest'

// @testing-library/svelte's own auto-cleanup only registers itself
// against a *global* afterEach, which we don't enable (no `globals:
// true` — every test file imports vitest's APIs explicitly).
afterEach(() => cleanup())
