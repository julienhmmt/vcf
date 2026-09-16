# Messaging

UI pages and content scripts never talk to Vault. They send messages to
the service worker with `browser.runtime.sendMessage` and get back

```ts
{ ok: true, value: T } | { ok: false, error: { kind: string, message: string } }
```

`src/background/router.ts` is the reference; this page is the summary.

## Senders

The worker classifies every sender before reading the message:

| Sender | Recognised by | Called |
|--------|---------------|--------|
| Popup, options, wizard | `sender.origin` (or `sender.url`) is our extension origin | page |
| Content script | our extension id, plus `sender.tab` and `sender.url` | content |
| Anything else | — | rejected, `forbidden_sender` |

There is no `onMessageExternal` listener and there must never be one.

## Requests

| `type` | From | Payload | Returns |
|--------|------|---------|---------|
| `status` | page, content | — | full `Status` for pages; `{ configured, unlocked }` for content |
| `probe` | page | `address`, `namespace?` | server health |
| `config/get` | page | — | current config (non-secret), or `null` |
| `config/save` | page | `config` (see `config.ts`) | `Status` |
| `login` | page | `input`: `{method:'token',token}` · `{method:'userpass'\|'ldap',password}` · `{method:'approle',secretId}` · `{method:'oidc'}` | `Status` |
| `logout` | page | — | revokes, clears session and index |
| `lock` | page | — | revokes, clears session, keeps index |
| `index/refresh` | page | — | `{ count, problems, builtAt }` |
| `matches/tab` | page | `tabId` | `{ unlocked, candidates }` |
| `matches/frame` | content | `userAction` | `{ unlocked, candidates }` |
| `fill` | page, content | `mount`, `path`, `allowDowngrade`, `tabId` (pages only) | `{ username, password, totp }` booleans |

URLs are never taken from a message. `matches/tab` and page fills use the
tab's URL as reported by the browser (top frame); content-script requests
use the sending frame's URL. The worker re-runs the matcher on that URL
before filling, so a credential can only reach a page it was tagged for.

Only `matches/*` with a user action, `login` and `fill` count as activity
for the idle lock. A content script looking up candidates on page load
must send `userAction: false`.

## Fill delivery

The worker reads the secret, computes the TOTP code if a seed is
declared, and sends one message to the target frame:

```ts
{ type: 'vcf/fill', username: string | null, password: string | null, totp: string | null }
```

The content script fills and drops the values. Nothing else ever carries
secret material; the seed itself never leaves the worker.

## Error kinds

Vault kinds from `src/vault/errors.ts`, plus:

| Kind | Meaning |
|------|---------|
| `not_configured` | setup not done |
| `locked` | no valid session |
| `host_permission` | Vault origin not granted; call `permissions.request` from the page |
| `no_match` | credential does not belong to the target frame |
| `downgrade` | http page, credential not tagged http; resend with `allowDowngrade: true` after the user confirms |
| `unsupported_page` | not http(s), or tab not visible |
| `no_receiver` | no content script in the target frame |
| `bad_request` | malformed message or wrong login method |
| `forbidden_sender` | see above |
| `config` | invalid setup input, message names the field |
| `internal` | anything unexpected; details are not sent |
