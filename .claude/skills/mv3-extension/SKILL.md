---
name: mv3-extension
description: Use when working on the extension shell — manifest.json, the service worker, storage layout, alarms, or anything that differs between Chrome and Firefox. Covers Manifest V3 constraints and cross-browser packaging.
---

# Manifest V3 extension shell

Scope: `manifest.json`, `src/background/` (service worker), build config.

## Service worker constraints

- The service worker is killed after ~30s of inactivity (Chrome) and on
  idle in Firefox's event-page equivalent. **Never hold state in module-level
  variables** across an async gap — it may not exist when the callback
  fires. Persist anything that must survive to `chrome.storage.session` (in
  memory, cleared on browser close — right place for the Vault token) or
  `chrome.storage.local` (disk-persisted — never for secrets).
- Use `chrome.alarms` for anything recurring (token renewal, index refresh),
  not `setInterval`/`setTimeout`. Alarms wake a killed service worker;
  timers don't survive it.
- All message listeners (`chrome.runtime.onMessage`,
  `chrome.runtime.onMessageExternal`) must be registered synchronously at
  the top level of the service worker script, not inside an async function
  or a conditional — Chrome only wires up listeners present on the first,
  synchronous tick.

## Storage split

| Storage | Contents | Lifetime |
|---|---|---|
| `storage.session` | Vault token, unlocked-state flag | cleared on browser close, never written to disk |
| `storage.local` | index (metadata only, never secret values), Vault URL, auth method config | persists across restarts |
| in-memory only | decrypted secret value during a fill | cleared immediately after use, never touches any storage API |

Never put a token or secret value in `storage.local` or `storage.sync`.
`storage.sync` is out entirely for anything Vault-related — it syncs via the
browser vendor's servers.

## Index lifecycle

- Build/refresh triggers: extension install, Vault URL/auth change, manual
  refresh, and a periodic alarm (e.g. every 15 min) — not on every popup
  open, that's wasteful and racy against a mid-refresh state.
- Store a `lastIndexedAt` and surface staleness in the UI rather than
  refreshing synchronously when the user opens the popup.

## Chrome vs Firefox manifest differences

- Background: Chrome MV3 uses `"background": {"service_worker": "..."}`.
  Firefox's MV3 support still expects
  `"background": {"scripts": ["..."], "type": "module"}` (no persistent
  event-page semantics like Chrome's SW, but the same "can be suspended"
  rules apply — write to it defensively either way).
- Firefox requires `"browser_specific_settings": {"gecko": {"id": "..."}}`
  for a stable extension ID (needed for `storage.sync` if ever used, and for
  AMO signing).
- Use `webextension-polyfill` (or the `browser.*` alias it provides) so the
  same codebase targets both without `chrome.*`/`browser.*` branching
  throughout.
- `host_permissions` for the Vault API host is added dynamically at setup
  time via `chrome.permissions.request` (Chrome) — Firefox supports the same
  API. Don't bake the user's Vault URL into `manifest.json`'s static
  `host_permissions`.

## CSP

MV3 forbids remote code execution and inline scripts by default. The Svelte
build must emit no inline `<script>` in the popup/options HTML — check the
Vite/WXT output, some plugins inject an inline bootstrap by default.

## Build tooling

Prefer **WXT** (handles the manifest-generation and Chrome/Firefox dual
build out of the box) over hand-rolled Vite config, unless there's a
specific reason not to — check what's already decided in `package.json`
before introducing a new build tool.

## Minimal permissions

Request only what's needed at manifest time: `storage`, `alarms`,
`activeTab` (not broad `tabs`), `identity` (only if OIDC is enabled). Add the
Vault host via optional `host_permissions` requested at setup, not declared
upfront.
