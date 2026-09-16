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

> **Status: early development.** The matching core and the Vault
> client are implemented and tested. There is no usable extension yet.

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
test/integration/ # against real servers, see below
dev/              # docker compose + seed fixtures
docs/
  secret-schema.md
```

Neither `src/core` nor `src/vault` touches an extension API: both
run under Node and are tested without a browser. The client only
needs `fetch` and `AbortSignal.any` (Chrome 116+, Firefox 124+).

## Development

```sh
npm install
npm run check          # typecheck + tests, what CI runs
npm run test:watch     # vitest in watch mode
npm run test:coverage
```

CI runs typecheck and tests on Node 22 and 24, enforces coverage
thresholds on `src/`, and runs the integration suite against both
servers.

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

## Roadmap

1. **Core matching** — done
2. **Vault client** — done: auth (token / userpass / LDAP / AppRole /
   OIDC), mount discovery, kv-v1 and kv-v2 list and read, token
   renewal, ACL-aware indexing
3. **Service worker** — storage split, index lifecycle, alarms
4. **Setup wizard and picker** — Svelte
5. **Content script** — form detection and fill
6. **Hardening** — lock timeout, fill confirmation, scheme-downgrade
   warnings

## Prior art

[mulbc/vaultPass](https://github.com/mulbc/vaultPass) covers the same
ground and works today. VaultCredsFiller differs in matching secrets
by metadata rather than by a regex encoded in the secret path, which
removes the need to reorganise an existing tree.

## License

MIT
