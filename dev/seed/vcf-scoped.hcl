# Index restricted to what the identity may eventually read.
path "secret/metadata/perso/*" {
  capabilities = ["read", "list"]
}
path "secret/data/perso/*" {
  capabilities = ["read"]
}
