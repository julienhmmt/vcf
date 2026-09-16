#!/bin/sh
# Loads the VaultCredsFiller test fixtures into a dev Vault or OpenBao.
#
# Works with either CLI: set CLI=vault or CLI=bao and the matching
# *_ADDR / *_TOKEN variables. Idempotent on a fresh dev server and safe
# to re-run on a live one.
#
# Fixed credentials, for tests and manual use only:
#   token     vcf-token                       (policy vcf-filler)
#   userpass  vcf / vcf                       (policy vcf-filler)
#   userpass  scoped / scoped                 (policy vcf-scoped)
#   approle   role_id vcf-role, secret_id vcf-secret  (policy vcf-filler)
set -eu

CLI="${CLI:-vault}"
HERE="$(cd "$(dirname "$0")" && pwd)"
c() { "$CLI" "$@"; }

log() { printf '[seed:%s] %s\n' "$CLI" "$*"; }

enabled_secrets() { c secrets list -format=json; }
enabled_auth() { c auth list -format=json; }

enable_kv() {
  path="$1" version="$2"
  if enabled_secrets | grep -q "\"$path/\""; then
    log "mount $path/ already there"
  else
    c secrets enable -path="$path" -version="$version" kv >/dev/null
    log "mount $path/ enabled (kv-v$version)"
  fi
}

enable_auth() {
  if enabled_auth | grep -q "\"$1/\""; then
    log "auth $1/ already there"
  else
    c auth enable "$1" >/dev/null
    log "auth $1/ enabled"
  fi
}

# put MOUNT PATH key=value...    (kv-v2 data)
put() { mount="$1" path="$2"; shift 2; c kv put -mount="$mount" "$path" "$@" >/dev/null; }
# meta MOUNT PATH key=value...   (kv-v2 custom_metadata)
meta() {
  mount="$1" path="$2"; shift 2
  n=$#
  for kv; do set -- "$@" "-custom-metadata=$kv"; done
  shift "$n"
  c kv metadata put -mount="$mount" "$@" "$path" >/dev/null
}

# --- CORS ------------------------------------------------------------
# Extension service workers with host permissions are exempt from CORS,
# but once enabled Vault rejects any Origin it does not list, so allow
# all of them rather than guess extension IDs.
c write sys/config/cors enabled=true allowed_origins='*' \
  allowed_headers='X-Vault-Token,X-Vault-Namespace,X-Vault-Request,Content-Type' >/dev/null
log "CORS enabled"

# --- mounts ----------------------------------------------------------
enable_kv secret 2
enable_kv team 2
enable_kv legacy 1

# --- secret/ (kv-v2): the main fixture tree --------------------------

# Declared URL list, title override.
put  secret perso/gitlab username=julien password=gitlab-pass
meta secret perso/gitlab 'url=https://gitlab.example.net,https://git.example.net' 'title=GitLab interne'

# No metadata at all: matched through the path segment.
put  secret perso/github.com username=julien-gh password=github-pass

# Custom data keys + exact path-prefix matching.
put  secret perso/jira login=jdoe pass=jira-pass
meta secret perso/jira url=https://tools.example.net/jira match=exact username_key=login password_key=pass title=Jira

# TOTP seed, email as username.
put  secret perso/mail email=julien@example.net password=mail-pass totp=JBSWY3DPEHPK3PXP
meta secret perso/mail url=https://mail.example.net totp_key=totp

# Two credentials for the same host, to exercise ordering.
put  secret perso/nextcloud-admin username=admin password=nc-admin-pass
meta secret perso/nextcloud-admin url=https://cloud.example.net title='Nextcloud (admin)'
put  secret perso/nextcloud-user username=julien password=nc-user-pass
meta secret perso/nextcloud-user url=https://cloud.example.net title='Nextcloud (julien)'

# Deeper tree, non-default port.
put  secret perso/infra/proxmox username=root@pam password=pve-pass
meta secret perso/infra/proxmox url=https://pve.example.net:8006 match=host

# Local pages, for the content-script phase.
put  secret perso/local-test username=local password=local-pass
meta secret perso/local-test url=http://localhost:8080 title='Local test page'

# Opted out.
put  secret perso/ignored username=nope password=nope
meta secret perso/ignored url=https://gitlab.example.net vcf=ignore

# Neither a url nor a hostname-looking name: never indexed.
put  secret perso/notes content='just a note'

# Metadata is readable by vcf-filler, data is not → 403 on fill.
put  secret pro/grafana username=ops password=grafana-pass
meta secret pro/grafana url=https://grafana.example.net

# Soft-deleted latest version: metadata remains, data read is 404.
put  secret perso/deleted username=gone password=gone
meta secret perso/deleted url=https://old.example.net
c kv delete -mount=secret perso/deleted >/dev/null

log "secret/ loaded"

# --- team/ (kv-v2): second mount ------------------------------------
put  team shared/wiki user=team password=wiki-pass
meta team shared/wiki url=https://wiki.example.net
log "team/ loaded"

# --- legacy/ (kv-v1): path-segment matching only -------------------
c write legacy/sites/example.org username=legacy password=legacy-pass >/dev/null
c write legacy/sites/intranet username=x password=y >/dev/null
log "legacy/ loaded"

# --- policies --------------------------------------------------------
c policy write vcf-filler "$HERE/vcf-filler.hcl" >/dev/null
c policy write vcf-scoped "$HERE/vcf-scoped.hcl" >/dev/null
log "policies written"

# --- auth ------------------------------------------------------------
enable_auth userpass
c write auth/userpass/users/vcf password=vcf token_policies=vcf-filler token_ttl=1h token_max_ttl=4h >/dev/null
c write auth/userpass/users/scoped password=scoped token_policies=vcf-scoped token_ttl=1h >/dev/null

enable_auth approle
c write auth/approle/role/vcf token_policies=vcf-filler token_ttl=1h token_max_ttl=4h secret_id_ttl=0 >/dev/null
c write auth/approle/role/vcf/role-id role_id=vcf-role >/dev/null
# Fails when the secret_id already exists; the login below is the check.
c write auth/approle/role/vcf/custom-secret-id secret_id=vcf-secret >/dev/null 2>&1 || true
c write auth/approle/login role_id=vcf-role secret_id=vcf-secret >/dev/null

if ! c token lookup vcf-token >/dev/null 2>&1; then
  c token create -id=vcf-token -policy=vcf-filler -ttl=24h -explicit-max-ttl=72h -display-name=vcf >/dev/null 2>&1
fi
log "auth configured"

log "done"
