import { MatchQuality } from '../../core/types'
import { RpcError } from './messaging'

/** Short label for why a candidate was suggested (see AGENTS.md matcher). */
export function qualityLabel(quality: MatchQuality): string {
  switch (quality) {
    case MatchQuality.Exact:
      return 'Exact match'
    case MatchQuality.Host:
      return 'This site'
    case MatchQuality.Subdomain:
      return 'Related subdomain'
    case MatchQuality.Domain:
      return 'Same domain'
  }
}

/** Turns any error the RPC layer can throw into one line for the UI. */
export function describeError(error: unknown): string {
  if (error instanceof RpcError) {
    // Field-specific and safe to show verbatim (see ConfigError).
    if (error.kind === 'config') return error.message
    return KNOWN_KINDS[error.kind] ?? error.message
  }
  if (error instanceof Error) return error.message
  return 'Something went wrong'
}

const KNOWN_KINDS: Readonly<Record<string, string>> = {
  not_configured: 'Not set up yet.',
  locked: 'Unlock first.',
  host_permission: 'Access to the Vault server was not granted.',
  no_match: 'This credential does not belong to this page.',
  unsupported_page: 'This page cannot be filled.',
  no_receiver: 'Reload the page and try again.',
  bad_request: 'Something about that request was invalid.',
  forbidden_sender: 'Something about that request was invalid.',
  unauthenticated: 'Your session has expired. Sign in again.',
  permission: 'Vault denied access to this secret.',
  invalid: 'Vault rejected those credentials.',
  not_found: 'That secret no longer exists.',
  sealed: 'The Vault server is sealed or unreachable.',
  rate_limited: 'Vault is rate-limiting requests. Try again shortly.',
  server: 'Vault returned an unexpected error.',
  network: 'Could not reach the Vault server.',
  timeout: 'Vault did not respond in time.',
  aborted: 'Request cancelled.',
  protocol: 'Vault returned an unexpected response.',
  internal: 'Something went wrong.',
}

export function formatRelativeTime(epochMs: number, now: number): string {
  const seconds = Math.round((now - epochMs) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
