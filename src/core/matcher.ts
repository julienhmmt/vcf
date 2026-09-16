import { parseUrl } from './metadata'
import { MatchQuality } from './types'
import type { IndexEntry, Match, ParsedUrl } from './types'

/**
 * Ranks index entries against the page currently open.
 *
 * Ordering mirrors KeePassXC-Browser: the tighter the agreement
 * between the entry URL and the page URL, the higher the entry sits.
 * Entries that do not reach the strictness they asked for are dropped
 * rather than demoted.
 *
 * @param pageUrl - The full URL of the page being filled.
 * @param entries - The whole index; order is irrelevant.
 * @returns Matches sorted best-first, then by title for stability.
 */
export function findMatches(
  pageUrl: string,
  entries: readonly IndexEntry[],
): Match[] {
  const page = parseUrl(pageUrl)
  if (page === null) return []

  const matches: Match[] = []

  for (const entry of entries) {
    const best = bestMatchForEntry(page, entry)
    if (best !== null) matches.push(best)
  }

  return matches.sort(compareMatches)
}

function bestMatchForEntry(page: ParsedUrl, entry: IndexEntry): Match | null {
  let best: Match | null = null

  for (const candidate of entry.urls) {
    const quality = scoreUrlPair(page, candidate)
    if (quality === null) continue
    if (!satisfiesStrictness(quality, entry.strictness)) continue

    if (best === null || quality > best.quality) {
      best = { entry, quality, via: candidate }
    }
  }

  return best
}

/**
 * Compares one page URL to one entry URL.
 *
 * @returns The tier they agree on, or null when unrelated.
 */
export function scoreUrlPair(page: ParsedUrl, entry: ParsedUrl): MatchQuality | null {
  if (page.hostname === entry.hostname) {
    return isExact(page, entry) ? MatchQuality.Exact : MatchQuality.Host
  }

  if (isSubdomainOf(page.hostname, entry.hostname)) return MatchQuality.Subdomain
  if (isSubdomainOf(entry.hostname, page.hostname)) return MatchQuality.Subdomain

  // Never fall back to the registrable domain for a public suffix the
  // PSL could not resolve — that would make every `localhost` or bare
  // IP match every other one.
  if (page.domain !== null && page.domain === entry.domain) return MatchQuality.Domain

  return null
}

/**
 * Exact is reserved for entries that name a path prefix and see the
 * page sit under it. That is what distinguishes a credential scoped to
 * `/jira` from a generic one for the whole host.
 *
 * A declared scheme acts as a constraint rather than a promotion: an
 * `https` entry never reaches Exact on an `http` page, because a
 * downgraded scheme is exactly the case where filling silently would
 * be dangerous.
 */
function isExact(page: ParsedUrl, entry: ParsedUrl): boolean {
  if (entry.pathPrefix === undefined) return false
  if (entry.scheme !== undefined && entry.scheme !== page.scheme) return false

  const pagePath = page.pathPrefix ?? '/'
  return pagePath.startsWith(entry.pathPrefix)
}

/** True when `child` sits strictly below `parent`, label-wise. */
function isSubdomainOf(child: string, parent: string): boolean {
  return child.endsWith(`.${parent}`)
}

function satisfiesStrictness(
  quality: MatchQuality,
  strictness: IndexEntry['strictness'],
): boolean {
  switch (strictness) {
    case 'exact':
      return quality === MatchQuality.Exact
    case 'host':
      return quality >= MatchQuality.Host
    case 'domain':
    case undefined:
      return true
  }
}

function compareMatches(a: Match, b: Match): number {
  if (b.quality !== a.quality) return b.quality - a.quality

  // Declared URLs beat ones guessed from the path, so a deliberately
  // tagged secret always outranks an inferred namesake.
  if (a.entry.inferred !== b.entry.inferred) return a.entry.inferred ? 1 : -1

  return a.entry.title.localeCompare(b.entry.title)
}
