---
name: autofill-content-script
description: Use when working on the content script that detects login forms on a page and fills them. Covers form detection across shadow DOM/iframes/SPAs, framework-safe value injection, and isolated-world secret handling.
---

# Autofill content script

Scope: `src/content/` — injected into pages, isolated world.

## Isolated world discipline

The content script runs in an isolated world: it shares the page's DOM but
not its JS globals, which is exactly the boundary that keeps a secret value
safe from a malicious page script. Do not weaken this:

- Never `eval`, inject a `<script>` tag, or otherwise run code in the page's
  own JS context to set a field value.
- Never expose the filled value on a DOM attribute or a custom event that
  page scripts can read (e.g. no `element.dataset.vcfValue`).
- The secret value should exist in the content script's memory for as short
  a time as possible: receive it from the service worker in response to an
  explicit user fill action, write it directly into the field(s), then drop
  the reference. Don't cache it for a second fill.

## Form detection

- Query for `<input>` elements with `type="password"` as the anchor, then
  walk up to the nearest `<form>` (or, for formless logins — common on SPA
  login pages — the nearest common ancestor containing a plausible username
  field) to find the paired username/email field.
- **Shadow DOM**: `document.querySelectorAll` does not pierce shadow roots.
  Recurse into `element.shadowRoot` where present (open shadow roots only —
  closed ones are unreachable and that's fine, don't try to work around it).
- **Iframes**: a login form embedded in a same-origin iframe needs the
  content script injected into that frame too — declare
  `"all_frames": true` in the manifest's content_scripts entry, and treat
  cross-origin iframes as out of scope (can't be reached from the parent
  frame's content script; that's a browser security boundary, not a bug to
  fix).
- **SPAs**: forms can appear after initial load with no navigation event.
  Use a `MutationObserver` on `document.body` (scoped/debounced — don't
  re-scan the whole DOM on every mutation) rather than only scanning once on
  `document_idle`.

## Framework-safe value injection

Setting `.value` directly does not trigger React/Vue/Angular's internal
change tracking, so the framework's state won't see the filled value (form
appears filled, but submit sends empty/stale data). The correct sequence:

1. Use the native property setter, not the (possibly overridden) instance
   setter:
   ```js
   const setter = Object.getOwnPropertyDescriptor(
     window.HTMLInputElement.prototype, 'value'
   ).set;
   setter.call(inputEl, value);
   ```
2. Dispatch `new Event('input', { bubbles: true })` and
   `new Event('change', { bubbles: true })` afterward so React/Vue's
   listeners (attached via the synthetic/delegated event system) fire.
3. For contenteditable-based fields (rare, some SSO pages), fall back to
   `execCommand('insertText', ...)` or direct `textContent` + `input` event.

Test this against at least one React-based demo login form, not just plain
HTML — plain `.value = x` will look correct in a static-HTML test and still
fail on real sites.

## What the content script must NOT decide

Matching (which credential fits this page) happens in `src/core/matcher.ts`
via a message to the service worker — the content script only reports the
current page URL and receives ranked candidates back. Keep matching logic
out of the content script; it's tested in isolation in `src/core` and
duplicating it here would drift.

## Testing

Content-script DOM logic (detection, value injection) is straightforward to
unit test with `jsdom`/`happy-dom` under vitest for the plain-HTML cases;
shadow DOM and framework-controlled-field behavior need a real browser —
cover those with a Playwright test against small fixture pages checked into
`test/fixtures/` rather than trying to fully emulate them in jsdom.
