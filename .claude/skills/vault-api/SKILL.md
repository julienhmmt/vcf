---
name: vault-api
description: Use when implementing or touching the Vault/OpenBao client (auth, mount discovery, kv-v1/kv-v2 read/list, token renewal). Covers the HTTP contract, both auth backends we support, and Vault vs OpenBao differences.
---

# Vault / OpenBao API client

Scope: `src/vault/` (service-worker side, no DOM). Keep this layer free of
extension APIs beyond `fetch` and `chrome.storage.session`, so it stays
testable with mocked HTTP like `src/core`.

## Mount discovery

- `GET /v1/sys/internal/ui/mounts` (needs a valid token) lists all mounts and
  their `options.version` (`"1"` or `"2"` for kv). Do this once per session
  and cache the mount → version map; don't hardcode `secret/`.
- A mount can be kv-v1 or kv-v2. Never assume v2 just because the mount is
  named `secret/`.

## kv-v2 paths

Given a mount `secret/` and a logical path `perso/gitlab`:

- Metadata (what the index builder reads): `GET /v1/secret/metadata/perso/gitlab`
  — returns `custom_metadata` under `data.custom_metadata`.
- List: `LIST /v1/secret/metadata/perso` (method `LIST`, or `GET` with
  `?list=true`).
- Data (only on fill, never during indexing): `GET /v1/secret/data/perso/gitlab`
  — secret data is under `data.data`, current version only unless
  `?version=N`.

## kv-v1 paths

No `metadata/`/`data/` split: `GET /v1/secret/perso/gitlab` returns the raw
map directly. kv-v1 has **no `custom_metadata`**, so kv-v1 secrets can only
be matched by path-derived heuristics (last segment as hostname) or a
`vcf`-prefixed key inside the secret's own data, never by the schema in
`docs/secret-schema.md`. Document this limitation in the UI rather than
silently ignoring kv-v1 mounts.

## Auth methods

All auth responses return `auth.client_token`, `auth.lease_duration`,
`auth.renewable`.

- **Token**: user pastes one directly, `X-Vault-Token` header. No login call.
- **Userpass**: `POST /v1/auth/userpass/login/<username>` with
  `{"password": "..."}`.
- **AppRole**: `POST /v1/auth/approle/login` with `{"role_id", "secret_id"}`.
  Never store `secret_id` — treat it like the credential it is.
- **OIDC**: `POST /v1/auth/oidc/oidc/auth_url` gets the provider URL, then
  drive it through `chrome.identity.launchWebAuthFlow` (interactive), then
  `POST /v1/auth/oidc/oidc/callback` with the returned `state`/`code`. This
  is the fiddliest one — test against a real OIDC-backed Vault dev server,
  not just mocks.

## Token lifecycle

- `GET /v1/auth/token/lookup-self` → `data.ttl`, `data.renewable`,
  `data.policies`. Call this right after login and periodically to detect
  revocation.
- `POST /v1/auth/token/renew-self` with `{"increment": "<seconds>"}` before
  TTL expiry — schedule via `chrome.alarms`, not `setTimeout` (service
  worker can be killed).
- On 403/expired token: clear `storage.session`, surface a re-auth prompt.
  Never silently retry with a stale token.

## Namespaces (Vault Enterprise)

If the user sets a namespace, send `X-Vault-Namespace: <ns>` on every
request, including login. OpenBao has no namespace concept — leave the field
absent/empty rather than erroring.

## Vault vs OpenBao differences

- API surface is the same for everything above; OpenBao is a fork of Vault
  1.x and tracks the kv-v2 and auth engine contracts closely.
- Don't gate behavior on a `X-Vault-*` response header to detect which one
  you're talking to — let the user declare it, or just don't branch at all
  since the contract matches for our subset.
- OpenBao's default port and some enterprise-only auth methods
  (Vault-only: some SaaS OIDC integrations) may not apply; don't assume every
  Vault Enterprise feature is present.

## CORS and permissions

The extension calls the Vault/OpenBao API directly from the service worker.
The user's Vault instance needs CORS enabled
(`vault write sys/config/cors ...` or the OpenBao equivalent) — this can't be
worked around from the extension side. Declare the Vault host in
`host_permissions` (user-configured, added at setup time), never a wildcard
`<all_urls>` for API calls.

## Testing

Mock `fetch` (msw or a hand-rolled fixture map) with real response shapes
captured from a dev Vault/OpenBao instance where possible. Cover: expired
token mid-request, kv-v1 mount, kv-v2 mount, missing `custom_metadata`,
namespace header, and a 5xx from Vault (must not crash the index builder).
