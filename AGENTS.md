# AGENTS.md

This file is the source of truth for any AI coding agent working in this
repository (Claude included — this supersedes any `CLAUDE.md` if one ever
appears; don't create a separate `CLAUDE.md`, edit this file instead).

## What this is

VaultCredsFiller: a browser extension (Chrome + Firefox, Manifest V3) that
autofills login forms from secrets stored in HashiCorp Vault or OpenBao,
matched by `custom_metadata` rather than a naming convention. Security- and
trust-sensitive by nature — it's designed to handle the user's credentials.

Full product description: `README.md`. Secret-tagging contract:
`docs/secret-schema.md` (this is the contract `src/core` is built on;
changing it means rewriting the index builder and matcher together).

## Status

Early development. Core matching (`src/core/`), the Vault client
(`src/vault/`) and the service worker (`src/background/`) are implemented
and tested. UI and content script are not built yet. Check the Roadmap section of `README.md` for current progress
before assuming a piece exists.

## Layout

```
src/core/       # no browser, no network — pure domain logic
  types.ts        domain types
  metadata.ts     custom_metadata + URL parsing
  matcher.ts      page URL → ranked candidates
  credential.ts, renewal.ts
src/vault/      # Vault/OpenBao HTTP client — implemented
  client.ts, http.ts, auth.ts, oidc.ts, kv.ts, mounts.ts, indexer.ts, errors.ts
src/background/ # MV3 service worker logic — implemented; browser APIs only
                #   in browser-platform.ts, everything else behind Platform
src/entrypoints/# WXT entrypoints (background.ts)
src/ui/         # Svelte popup / options / setup wizard (planned)
src/content/    # form-detection + fill content script (planned)
docs/
  secret-schema.md
dev/            # local Vault/OpenBao dev environment (docker-compose + seed scripts)
```

`src/core` must stay free of any browser/extension API so it can be driven
and tested from plain Node. Don't let `fetch`, `chrome.*`, or DOM access
leak into it.

## Commands

```sh
npm install
npm run check          # typecheck + tests — what CI runs, run before every commit
npm run typecheck
npm run test            # vitest run
npm run test:watch
npm run test:coverage
npm run test:integration   # needs dev/docker-compose.yml up
npm run build              # WXT, Chrome MV3; build:firefox for Firefox
```

CI (`.github/workflows/ci.yml`) runs on Node 22 and 24, builds both
browsers, enforces coverage thresholds on `src/`, and runs the integration
suite against Vault and OpenBao. Build tooling is WXT (dev dependency only).
Message protocol: `docs/messaging.md`.

## Skills

This repo has project skills under `.claude/skills/`, one per roadmap area.
Load the one matching what you're touching before writing code:

- `vault-api` — Vault/OpenBao HTTP client, auth methods, kv-v1/kv-v2, token
  lifecycle
- `mv3-extension` — manifest, service worker, storage split, Chrome/Firefox
  differences
- `svelte-extension-ui` — popup/options/wizard UI, Svelte 5 runes, messaging
  with the service worker
- `autofill-content-script` — form detection, shadow DOM/iframes/SPAs,
  framework-safe value injection
- `extension-security-review` — run before merging anything touching the
  token, secret values, cross-context messaging, or the content script, and
  before any release
- `extension-release` — packaging, linting, version bump, store submission

## Non-negotiable rules

These come out of `extension-security-review` but are worth stating here
because they apply to *any* change, not just ones that look security-related:

- Vault token → `storage.session` only, never `storage.local`/`storage.sync`.
- Secret values (passwords, TOTP) are never written to any storage API —
  in-memory for the duration of one fill only.
- No auto-fill on page load or "best match" — every fill needs an explicit
  user action.
- Warn on scheme downgrade (tagged `https://` vs current page `http://`)
  before filling.
- Every `chrome.runtime.onMessage` handler validates `sender` before acting.
- No `eval`/injected `<script>`/page-context execution from the content
  script — it runs in the isolated world and must stay there.
- New runtime dependency (beyond the current `tldts`) needs explicit
  justification, not a routine add — this codebase's whole value is
  trustworthy secret handling.

## PR / commit expectations

- `npm run check` clean before committing.
- Any diff touching `src/vault`, `src/background`, `storage.*` calls, or
  `src/content` gets the `extension-security-review` checklist applied —
  treat a finding as a blocker, not a style note.
- Keep `src/core` dependency-free of browser APIs (see Layout above) — this
  is what makes it testable from Node without a browser.
