# What the extension needs, and no more.

# Build the index: enumerate paths and read custom_metadata.
path "secret/metadata/*" {
  capabilities = ["read", "list"]
}
path "team/metadata/*" {
  capabilities = ["read", "list"]
}

# Fill: read secret data. pro/ is deliberately absent.
path "secret/data/perso/*" {
  capabilities = ["read"]
}
path "team/data/*" {
  capabilities = ["read"]
}

# kv-v1 has no metadata: list and read go through the same path.
path "legacy/*" {
  capabilities = ["read", "list"]
}
