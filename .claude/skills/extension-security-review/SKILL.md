---
name: extension-security-review
description: Use before merging any change that touches the token, secret values, cross-context messaging, or the content script — and as a pre-release checklist. This extension's entire value proposition is trustworthy secret handling; treat every deviation from this list as a blocker, not a nitpick.
---

# Extension security review checklist

Run this whenever a change touches: the Vault client, `storage.*` calls,
`chrome.runtime` messaging, or `src/content/`. Also run it wholesale before
any release build.

## Message sender validation

Every `chrome.runtime.onMessage` / `onMessageExternal` handler in the
service worker must check `sender` before acting:

- `onMessage` (from own extension's popup/options/content script): verify
  `sender.id === chrome.runtime.id` if reachable, and for content-script
  messages, that `sender.tab` is present and, where relevant, that
  `sender.url` matches the page the fill was requested for (prevents a
  stale/cross-tab message from triggering a fill on the wrong page).
- `onMessageExternal` should not exist for this extension — there's no
  legitimate external caller. If it appears, that's a finding on its own.

## Token and secret storage

- Vault token: `storage.session` only. Grep any diff touching storage for
  `storage.local.set` or `storage.sync.set` near anything token/secret-named
  — that's an automatic block.
- Secret values (passwords, TOTP seeds): never written to *any* storage
  API. They exist only as in-memory values passed service-worker → content
  script for the duration of one fill, then dropped. No caching "for the
  next field on this page" beyond the single fill operation.
- The index (`storage.local`) must contain metadata only —
  `custom_metadata` fields, secret path, title. Confirm the index builder
  never persists `data.data` from a kv-v2 read.

## Scheme-downgrade warning

Before filling, compare the tagged `url`'s scheme to the current page's
scheme. If the secret is tagged `https://...` and the current page is
`http://...` (or the page URL's scheme is weaker than tagged), show a
blocking warning rather than filling silently — this is the main real-world
attack this class of tool is vulnerable to (credential fill on a downgraded/
spoofed page).

## Fill confirmation

No auto-fill on page load and no auto-fill on "best match" alone. The user
must take an explicit action (click a candidate in the picker, or a
keyboard-driven equivalent) before any value is written into the page.
Silent/automatic filling is explicitly out of scope per the roadmap
("fill confirmation" is listed as a hardening step, not optional polish).

## Lock timeout

The unlocked state (valid token in `storage.session`) should have an
inactivity timeout separate from "browser still open" — check for a
`chrome.alarms`-driven lock after N minutes of no fill activity, clearing
`storage.session`. Flag if a change removes or weakens this without
discussion.

## Content-script boundary

- No `eval`, no injected `<script>` tags, no page-context code execution
  from the content script (see `autofill-content-script`).
- Filled value never attached to the DOM in a page-script-readable way
  (no custom attributes/events carrying the plaintext value).

## Least privilege

- `manifest.json` permissions: only what's declared as needed in
  `mv3-extension`. A new permission appearing in a diff needs a one-line
  justification in the PR description, not just an approval.
- `host_permissions` for the Vault host: added via `chrome.permissions.request`
  at setup time, not baked into the static manifest.

## Logging

No `console.log` of token, secret value, or full Vault response bodies —
even behind a debug flag, since debug flags get left on. Log paths/hostnames/
error codes only.

## Dependency surface

`tldts` is currently the only runtime dependency (`package.json`). Adding a
new runtime dependency to a codebase whose selling point is "handles your
credentials" is a real cost — prefer implementing small pieces of logic
directly over pulling in a package, and flag any new dependency for
explicit discussion rather than approving it as routine.

## Output format

When run as a review, report findings as: **blocker** (violates one of the
above — token/secret exposure, missing sender check, silent fill, missing
downgrade warning) vs **note** (style, non-security). Don't soften a blocker
into a suggestion.
