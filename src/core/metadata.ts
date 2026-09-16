import { parse as parseHost } from 'tldts'
import type {
  CustomMetadata,
  IndexEntry,
  MatchStrictness,
  ParsedUrl,
} from './types'

const URL_SEPARATOR = ','
const STRICTNESS_VALUES: readonly string[] = ['exact', 'host', 'domain']

/**
 * Normalises a user-written URL into the parts the matcher compares.
 *
 * Accepts bare hostnames (`github.com`) as well as full URLs, since
 * `custom_metadata` is hand-written and people omit the scheme.
 *
 * @returns null when the input has no usable hostname.
 */
export function parseUrl(raw: string): ParsedUrl | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const candidate = hasScheme ? trimmed : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }

  const hostname = url.hostname.toLowerCase()
  if (hostname === '') return null

  // tldts resolves the registrable domain against the Public Suffix
  // List, so `example.co.uk` does not collapse to `co.uk`.
  const { domain } = parseHost(hostname)

  const pathPrefix = url.pathname !== '/' ? url.pathname : undefined

  return {
    hostname,
    domain: domain ?? null,
    ...(hasScheme ? { scheme: url.protocol.replace(':', '') } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
  }
}

/** Splits and parses the comma-separated `url` metadata value. */
export function parseUrlList(raw: string): ParsedUrl[] {
  return raw
    .split(URL_SEPARATOR)
    .map(parseUrl)
    .filter((parsed): parsed is ParsedUrl => parsed !== null)
}

function readStrictness(value: string | undefined): MatchStrictness | undefined {
  if (value === undefined) return undefined
  const normalised = value.trim().toLowerCase()
  return STRICTNESS_VALUES.includes(normalised)
    ? (normalised as MatchStrictness)
    : undefined
}

function lastSegment(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? ''
}

/**
 * Builds an index entry from a secret's metadata.
 *
 * Falls back to treating the last path segment as a hostname when no
 * `url` is declared, so existing trees such as `secret/perso/github.com`
 * work without migration.
 *
 * @returns null when the secret is opted out or yields no usable URL.
 */
export function toIndexEntry(
  mount: string,
  path: string,
  metadata: CustomMetadata = {},
): IndexEntry | null {
  if (metadata.vcf?.trim().toLowerCase() === 'ignore') return null

  const declared = metadata.url ? parseUrlList(metadata.url) : []
  const inferred = declared.length === 0

  const urls = inferred ? inferUrlsFromPath(path) : declared
  if (urls.length === 0) return null

  return {
    mount,
    path,
    title: metadata.title?.trim() || lastSegment(path),
    urls,
    inferred,
    ...optional('strictness', readStrictness(metadata.match)),
    ...optional('usernameKey', metadata.username_key?.trim()),
    ...optional('passwordKey', metadata.password_key?.trim()),
    ...optional('totpKey', metadata.totp_key?.trim()),
  }
}

/**
 * A path segment only counts as a hostname if the Public Suffix List
 * recognises it. That rejects `gitlab` or `prod` while accepting
 * `github.com` and `git.example.co.uk`.
 */
function inferUrlsFromPath(path: string): ParsedUrl[] {
  const segment = lastSegment(path)
  if (!segment.includes('.')) return []

  const parsed = parseUrl(segment)
  if (parsed === null || parsed.domain === null) return []

  return [parsed]
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined || value === '' ? {} : ({ [key]: value } as Record<K, V>)
}
