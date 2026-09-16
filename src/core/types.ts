/**
 * Domain types shared by the index builder, the matcher and the UI.
 *
 * Nothing here depends on the browser or on the network, so every
 * module that imports only these types is testable under Node.
 */

export type KvVersion = 1 | 2

/** Strictness requested by a secret through `custom_metadata.match`. */
export type MatchStrictness = 'exact' | 'host' | 'domain'

/** Raw `custom_metadata` as returned by Vault: a flat string map. */
export type CustomMetadata = Record<string, string>

/**
 * One credential known to the extension.
 *
 * Built from metadata only — it carries no secret material. Holding
 * the whole index in memory is therefore cheap and comparatively safe.
 */
export interface IndexEntry {
  /** Mount point the secret lives in, without slashes, e.g. `secret`. */
  readonly mount: string
  /** Path inside the mount, e.g. `perso/gitlab`. */
  readonly path: string
  /** Label for the picker. */
  readonly title: string
  /** Parsed URLs this credential claims to serve. */
  readonly urls: readonly ParsedUrl[]
  /** Per-secret strictness override, if any. */
  readonly strictness?: MatchStrictness
  /** Data key holding the username, when explicitly declared. */
  readonly usernameKey?: string
  /** Data key holding the password, when explicitly declared. */
  readonly passwordKey?: string
  /** Data key holding a TOTP seed, when explicitly declared. */
  readonly totpKey?: string
  /** True when the entry came from the path-segment fallback. */
  readonly inferred: boolean
}

/** A URL reduced to the parts the matcher actually compares. */
export interface ParsedUrl {
  /** Full hostname, lowercased, e.g. `gitlab.example.net`. */
  readonly hostname: string
  /** Registrable domain (eTLD+1), e.g. `example.net`. */
  readonly domain: string | null
  /** `https` or `http`. Absent when the source had no scheme. */
  readonly scheme?: string
  /** Path prefix, when the source URL carried one beyond `/`. */
  readonly pathPrefix?: string
}

/**
 * How well an entry fits the current page. Higher is better; the
 * numeric values are the sort key and are deliberately spaced so new
 * tiers can be inserted without renumbering.
 */
export enum MatchQuality {
  /** Hostname and scheme and path prefix all agree. */
  Exact = 40,
  /** Hostname agrees. The common case. */
  Host = 30,
  /** Page is a subdomain of the entry's hostname, or the reverse. */
  Subdomain = 20,
  /** Same registrable domain, unrelated subdomains. */
  Domain = 10,
}

export interface Match {
  readonly entry: IndexEntry
  readonly quality: MatchQuality
  /** The entry URL that produced the match. */
  readonly via: ParsedUrl
}

/** Credential material, fetched on demand and never persisted. */
export interface Credential {
  readonly username: string | null
  readonly password: string | null
  readonly totpSeed: string | null
}
