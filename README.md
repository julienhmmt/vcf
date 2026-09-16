# VaultCredsFiller

[![CI](https://github.com/julienhmmt/vcf/actions/workflows/ci.yml/badge.svg)](https://github.com/julienhmmt/vcf/actions/workflows/ci.yml)

Browser extension that fills login forms with credentials stored in
HashiCorp Vault or OpenBao — the way KeePassXC-Browser does it, but
with your own Vault as the backend.

- Matches secrets to the current site through kv-v2 `custom_metadata`,
  so your existing secret layout stays untouched
- Builds its index from `metadata/` only — it never reads a secret
  until you ask it to fill one
- Token lives in session storage and is cleared when the browser closes
- Chrome and Firefox, Manifest V3
- kv-v1 and kv-v2; userpass, AppRole, OIDC or a raw token

> **Status: early development.** The matching core, the Vault client,
> the service worker, the Svelte UI and the content script are
> implemented and tested — the full fill path works end to end,
> including in shadow DOM, cross-frame and React-controlled forms
> (verified against real Chromium, not just jsdom). Not done yet:
> extension icons, a linted/signed release build.

## How a secret is tagged

```sh
vault kv put secret/perso/gitlab username=julien password='...'

vault kv metadata put secret/perso/gitlab \
  -custom-metadata=url=https://gitlab.example.net \
  -custom-metadata=title='GitLab interne'
```

Secrets already named after their host (`secret/perso/github.com`) are
picked up with no tagging at all. The full contract, including the
policies that let the extension index secrets it may not open, is in
[`docs/secret-schema.md`](docs/secret-schema.md).

## Layout

```
src/core/         # no browser, no network — pure domain logic
  types.ts          domain types
  metadata.ts       custom_metadata + URL parsing
  matcher.ts        page URL → ranked candidates
  credential.ts     secret data → username / password / TOTP
  renewal.ts        token lease arithmetic
src/vault/        # Vault / OpenBao HTTP client, fetch only
  http.ts           transport, deadlines, error mapping
  auth.ts           token, userpass/ldap, approle, renew, revoke
  oidc.ts           OIDC login, browser window injected
  mounts.ts         kv mount discovery, ACL-derived walk roots
  kv.ts             kv-v1 / kv-v2 list, metadata, data, tree walk
  indexer.ts        mount → index entries (metadata only)
  client.ts         VaultClient / SessionClient facade
src/background/   # service worker logic, browser behind an interface
  platform.ts       what the worker needs from the browser
  browser-platform.ts  the real binding (wxt/browser)
  config.ts         setup validation
  stores.ts         storage split: session vs local
  service.ts        unlock, renew, idle lock, index, match, fill
  router.ts         message protocol and sender checks
src/ui/           # Svelte helpers shared by popup and options
  lib/              messaging, typed RPC calls, formatting, wizard draft
  components/       Unlock.svelte (shared login form)
src/content/      # form detection and fill, isolated world, no messaging
  detect.ts         password-field anchor, username/otp pairing, shadow DOM
  inject.ts         framework-safe value injection (native setter + events)
  watch.ts          debounced MutationObserver re-scan for SPA logins
  badge.ts          in-page candidate list / fill / downgrade confirm
  rpc.ts            the two messages a content script may send
src/entrypoints/  # WXT entrypoints
  background.ts
  autofill.content.ts  wires detect/watch/badge together per frame
  popup/            App.svelte, Picker.svelte (candidate list, fill)
  options/          App.svelte, Wizard.svelte (setup), Settings.svelte
test/integration/ # against real servers, see below
dev/              # docker compose + seed fixtures
docs/
  secret-schema.md
```

Only `browser-platform.ts` and the entrypoints touch extension APIs;
everything else runs under Node and is tested without a browser. The client only
needs `fetch` and `AbortSignal.any` (Chrome 116+, Firefox 124+).

## Development

```sh
npm install
npm run check          # typecheck + tests, what CI runs
npm run test:watch     # vitest in watch mode
npm run test:coverage
npm run test:e2e       # content script against real Chromium, see below
npm run build          # .output/chrome-mv3
npm run build:firefox  # .output/firefox-mv3
npm run dev            # Chrome with live reload
```

The message protocol between UI, content script and worker is in
[`docs/messaging.md`](docs/messaging.md).

CI runs typecheck and tests on Node 22 and 24, enforces coverage
thresholds on `src/`, and runs the integration suite against both
servers.

### Content script against a real browser

`src/content/` is exercised by ordinary jsdom unit tests, but shadow
DOM, cross-frame boundaries and framework-controlled inputs aren't
faithfully reproducible there (see `src/content/inject.test.ts`'s own
comment on why a plain `.value =` bug wouldn't show up in a
static-HTML test). `test:e2e` bundles the actual `detect.ts`/
`inject.ts` — not a re-implementation — into three fixture pages under
`test/e2e/fixtures/` and runs them against real Chromium with
Playwright: a form inside an open shadow root, one inside a same-
origin iframe, and one driven by real React (vendored, not CDN-
fetched, so this stays offline-reproducible):

```sh
npx playwright install chromium   # once
npm run test:e2e
```

Needs a real browser download, which a restricted network may block
(sandboxed dev environments included) — CI always runs it, since
`actions/runner` images have full network access.

### Local Vault and OpenBao

```sh
docker compose -f dev/docker-compose.yml up -d --wait
npm run test:integration
```

| Server  | Address                 | Root token |
|---------|-------------------------|------------|
| Vault   | http://127.0.0.1:8200   | `root`     |
| OpenBao | http://127.0.0.1:8300   | `root`     |

Both run in dev mode (in-memory, reseeded on every `up`). The seed
job (`dev/seed/seed.sh`) creates on each server:

| What | Details |
|------|---------|
| `secret/` kv-v2 | tagged secrets under `perso/`, a metadata-only-readable `pro/grafana`, a soft-deleted and an opted-out secret |
| `team/` kv-v2 | `shared/wiki`, `user` as username key |
| `legacy/` kv-v1 | `sites/example.org`, matched by path |
| token | `vcf-token` (policy `vcf-filler`) |
| userpass | `vcf` / `vcf` (`vcf-filler`), `scoped` / `scoped` (`vcf-scoped`) |
| approle | role_id `vcf-role`, secret_id `vcf-secret` |

Versions are pinned in the compose file and can be overridden with
`VAULT_VERSION` / `OPENBAO_VERSION`. OIDC is not part of the stack:
it needs an IdP and is covered by unit tests only.

#### Testing the extension itself, end to end

1. `npm run build` (or `build:firefox`), then load `.output/chrome-mv3`
   as an unpacked extension (`chrome://extensions` → Developer mode →
   Load unpacked) or `.output/firefox-mv3` via `about:debugging` →
   "Load Temporary Add-on".
2. Bring up Vault/OpenBao and seed it (above).
3. Open the extension's options page and connect: address
   `http://127.0.0.1:8200` (or `:8300` for OpenBao), auth method
   userpass, username `vcf`, password `vcf` when prompted — grant the
   host permission when Chrome/Firefox asks.
4. `npm run dev:test-page` serves `dev/test-page/index.html` at
   `http://localhost:8080`, matching the `secret/perso/local-test`
   fixture seed.sh already tags for exactly that address. Open it: the
   in-page badge should appear next to the password field, and the
   popup's picker should list it for the active tab.
5. Vault has more path/host fixtures than that one page can exercise
   (subdomain and domain-quality matches, TOTP, a metadata-only-
   readable secret that 403s on fill, a soft-deleted one) — see the
   `put`/`meta` calls in `dev/seed/seed.sh` for the full list and what
   each is meant to prove.

## Roadmap

1. **Core matching** — done
2. **Vault client** — done: auth (token / userpass / LDAP / AppRole /
   OIDC), mount discovery, kv-v1 and kv-v2 list and read, token
   renewal, ACL-aware indexing
3. **Service worker** — done: storage split, index lifecycle,
   renewal / expiry / idle-lock alarms, sender-checked messaging,
   downgrade-checked fill with TOTP computed in the worker
4. **Setup wizard and picker** — done: Svelte 5 popup and options
   pages, message-based RPC to the worker (never calling Vault
   directly), non-secret wizard draft persistence, permission
   request flow for the Vault host
5. **Content script** — done: password-field detection (shadow DOM,
   SPA re-scan via MutationObserver), framework-safe value injection,
   an in-page badge for candidates/fill/downgrade-confirm next to the
   field itself, matching the popup's own picker
6. **Hardening** — lock timeout, fill confirmation and scheme-
   downgrade warnings landed as part of phases 3–5, not as separate
   work; this phase added a broader OTP-field heuristic (name/
   placeholder + numeric shape, not just the autofill hint) and
   `test:e2e`: the same detect/inject code run against real Chromium
   for shadow DOM, a same-origin iframe and a real React-controlled
   form, since jsdom can't faithfully stand in for any of those three.
   Left for an actual release: extension icons, `web-ext lint`,
   store packaging (see `.claude/skills/extension-release`)

## Prior art

[mulbc/vaultPass](https://github.com/mulbc/vaultPass) covers the same
ground and works today. VaultCredsFiller differs in matching secrets
by metadata rather than by a regex encoded in the secret path, which
removes the need to reorganise an existing tree.

## License

MIT
