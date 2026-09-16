import { isVaultError } from '../vault/errors'
import { ConfigError } from './config'
import type { VaultErrorKind } from '../vault/errors'

/** Failures the service worker reports on top of Vault's own. */
export type ServiceErrorKind =
  | 'not_configured'
  | 'locked'
  | 'host_permission'
  | 'no_match'
  | 'downgrade'
  | 'unsupported_page'
  | 'no_receiver'
  | 'bad_request'
  | 'forbidden_sender'
  | 'config'
  | 'internal'

export type ErrorKind = ServiceErrorKind | VaultErrorKind

export class ServiceError extends Error {
  override readonly name = 'ServiceError'
  constructor(
    readonly kind: ServiceErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export interface WireError {
  readonly kind: ErrorKind
  readonly message: string
}

/**
 * What crosses the message boundary. Only the kind and a short
 * message: never a stack, never a response body.
 */
export function toWireError(error: unknown): WireError {
  if (error instanceof ServiceError) return { kind: error.kind, message: error.message }
  if (isVaultError(error)) return { kind: error.kind, message: error.message }
  if (error instanceof ConfigError) return { kind: 'config', message: error.message }
  return { kind: 'internal', message: 'Unexpected error' }
}
