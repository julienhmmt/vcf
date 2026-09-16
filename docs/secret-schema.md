# Secret schema

VaultCredsFiller does not impose a directory layout on your Vault or
OpenBao instance. It discovers which secrets belong to which site by
reading the kv-v2 `custom_metadata` of each secret.

This is the contract every other part of the extension is built on.
Changing it means rewriting the index builder and the matcher.

## Fields

All fields live in `custom_metadata`. All are optional except `url`.

| Key        | Required | Example                          | Meaning |
|------------|----------|----------------------------------|---------|
| `url`      | yes      | `https://gitlab.example.net`     | One or more URLs this credential applies to, comma-separated |
| `title`    | no       | `GitLab interne`                 | Label shown in the picker. Defaults to the last path segment |
| `username_key` | no   | `login`                          | Which data key holds the username. Default: first match of `username`, `user`, `login`, `email` |
| `password_key` | no   | `pass`                           | Which data key holds the password. Default: first match of `password`, `pass`, `secret` |
| `totp_key` | no       | `totp`                           | Data key holding a TOTP seed (`otpauth://` URI or raw base32) |
| `match`    | no       | `exact` \| `host` \| `domain`    | Overrides the default matching strictness for this secret |
| `vcf`      | no       | `ignore`                         | `ignore` excludes the secret from the index entirely |

### Why `url` is a list

One credential often serves several hostnames (`gitlab.example.net`
and `git.example.net`). Comma-separated keeps it inside a single
`custom_metadata` value, which is a flat string map — no nesting
available.

```
url=https://gitlab.example.net,https://git.example.net
```

### Why no regex

vaultPass encoded a regex in the secret path. Two problems: regex
metacharacters sit badly in Vault paths, and it forces a dedicated
tree. Here a URL is a URL. Strictness is controlled by `match`, and
the matcher handles subdomains structurally rather than textually.

## Writing a secret

```sh
vault kv put secret/perso/gitlab \
  username=julien \
  password='...'

vault kv metadata put secret/perso/gitlab \
  -custom-metadata=url=https://gitlab.example.net \
  -custom-metadata=title='GitLab interne'
```

Note that `kv put` and `kv metadata put` are two separate calls. The
metadata write does not touch the secret data and can be done by a
different, less privileged identity.

## Fallback when `url` is absent

If a secret has no `url` in its `custom_metadata`, the last path
segment is tried as a hostname. `secret/perso/github.com` matches
`github.com`. This makes existing, sanely-named trees work with zero
migration.

A secret whose last segment is not a plausible hostname (no dot, or
not parseable) is simply left out of the index.

## Policies

The central property of this schema: the extension builds its whole
index from `metadata/` and never touches `data/` until you pick a
credential to fill. That lets you split the two.

### Read-only filler policy

```hcl
# Enumerate and read metadata across the tree — this is what builds
# the index. Reveals paths and URLs, never a password.
path "secret/metadata/*" {
  capabilities = ["read", "list"]
}

# Read the secret itself. Narrow this as much as you can.
path "secret/data/perso/*" {
  capabilities = ["read"]
}
```

With this policy the extension can tell you "3 credentials exist for
this site" even for secrets it is not allowed to open. Attempting to
fill one returns 403 and the extension reports it plainly rather
than failing silently.

### Restricting the index itself

If revealing paths is itself a concern, scope the metadata grant:

```hcl
path "secret/metadata/perso/*" {
  capabilities = ["read", "list"]
}
```

The index then only contains what that identity may eventually read.

Such a policy forbids listing the mount root. The extension reads the
token's effective ACL (`sys/internal/ui/resultant-acl`, part of the
default policy) and starts its walk at `perso/` instead. A `+`
segment wildcard (`secret/metadata/+/web/*`) cannot be walked into
without list rights on its parent; grant those or declare the
subtree explicitly.

## kv-v1

kv-v1 has no metadata endpoint and no `custom_metadata`. For a v1
mount the extension falls back to path-segment matching only, and
must read `data` to enumerate keys. The metadata/data split above
does not apply. Supported, but v2 is strongly preferred.
