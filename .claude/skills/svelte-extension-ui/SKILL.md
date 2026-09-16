---
name: svelte-extension-ui
description: Use when building the popup, options page, or setup wizard UI in Svelte. Covers Svelte 5 runes conventions, extension-specific entry points, and messaging with the service worker.
---

# Svelte UI for the extension

Scope: `src/ui/` — popup, options/setup-wizard, credential picker.

## Svelte 5 runes

- Use runes (`$state`, `$derived`, `$effect`, `$props`) — not the Svelte 4
  reactive `let`/`$:` style. Check `package.json` for the Svelte major
  version before writing new components; match whatever the rest of the
  codebase uses once components exist.
- Keep Vault/index state in a small number of shared `$state` stores
  (e.g. one module exporting a `credentialIndex` rune-based store) rather
  than prop-drilling through popup → picker → row components.

## Entry points

Each of popup, options page, and setup wizard is a **separate HTML entry**
(`popup.html`, `options.html`), each mounting its own Svelte root — not
router-based navigation inside one page. This matches how Chrome/Firefox
load extension UI and keeps bundle size per surface small.

## No inline scripts

The build output must not emit an inline `<script>` block in these HTML
files — MV3 CSP blocks it. Verify the built `popup.html`/`options.html`
reference an external `.js` file only; check this after any Vite/WXT config
change.

## Messaging with the service worker

- UI components never call the Vault API directly — they send a message
  (`chrome.runtime.sendMessage`) to the service worker and await the
  response. This keeps the token and Vault calls entirely in the
  service-worker/`src/vault` layer, so a compromised or buggy UI component
  can't be tricked into exfiltrating a secret over `fetch`.
- Define message shapes as a discriminated union in `src/core/types.ts` (or
  a sibling `messages.ts`) shared between UI and service worker, so
  typecheck catches a mismatched message contract — don't pass loosely-typed
  objects across `sendMessage`.
- Handle the "service worker was asleep, message arrives before it's ready"
  race: `sendMessage` from a popup can fire before a freshly-woken SW has
  registered its listener. Use `chrome.runtime.onMessage` returning `true`
  for async responses correctly, and treat a `lastError`/no-response as
  transient rather than fatal in the UI.

## Setup wizard specifics

Multi-step (Vault URL → auth method → auth details → verify connection →
done). Persist partial progress to `storage.local` as non-secret fields only
(Vault URL, auth method choice) so navigating away and back doesn't lose
work; never persist a password/secret_id mid-wizard even transiently.

## Picker UI

The credential picker (shown on a matched login form) ranks candidates from
the matcher (`src/core/matcher.ts`) — render its `match` strength (exact/
host/domain) so the user can tell why a candidate was suggested, and always
require an explicit click to fill (no auto-fill on best match alone — see
`extension-security-review`).

## Testing

Component tests via `@testing-library/svelte` + vitest (already the test
runner per `vitest.config.ts`) — assert on rendered output and emitted
messages to the service worker, not internal store shape.
