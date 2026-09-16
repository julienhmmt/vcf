import { VaultError, kindForStatus } from './errors'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface VaultHttpOptions {
  /** Base address, e.g. `https://vault.example.net:8200`. */
  readonly address: string
  /** Enterprise / OpenBao namespace, sent as `X-Vault-Namespace`. */
  readonly namespace?: string
  /** Per-request deadline. Default 10 s. */
  readonly timeoutMs?: number
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: FetchLike
}

export interface RequestOptions {
  readonly token?: string
  readonly body?: unknown
  readonly query?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal | undefined
}

/** Envelope shared by every Vault API response. */
export interface VaultResponse<D = unknown> {
  readonly data: D | null
  readonly auth: VaultAuthBlock | null
  readonly warnings?: readonly string[] | null
  readonly lease_duration?: number
  readonly renewable?: boolean
}

export interface VaultAuthBlock {
  readonly client_token: string
  readonly accessor: string
  readonly policies: readonly string[] | null
  readonly token_policies?: readonly string[] | null
  readonly lease_duration: number
  readonly renewable: boolean
  readonly entity_id?: string
  readonly metadata?: Readonly<Record<string, string>> | null
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Thin transport over the Vault HTTP API.
 *
 * Knows about addresses, headers, deadlines and error mapping. Knows
 * nothing about auth methods or secret engines.
 */
export class VaultHttp {
  readonly address: string
  readonly namespace: string | undefined
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor(options: VaultHttpOptions) {
    this.address = normaliseAddress(options.address)
    this.namespace = options.namespace?.trim().replace(/^\/+|\/+$/g, '') || undefined
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  get<D>(path: string, options?: RequestOptions): Promise<VaultResponse<D>> {
    return this.request<D>('GET', path, options)
  }

  post<D>(path: string, options?: RequestOptions): Promise<VaultResponse<D>> {
    return this.request<D>('POST', path, options)
  }

  /**
   * LIST via `GET ?list=true` rather than the custom `LIST` verb: a
   * non-standard method forces a CORS preflight and some proxies
   * reject it outright.
   */
  list<D>(path: string, options: RequestOptions = {}): Promise<VaultResponse<D>> {
    return this.request<D>('GET', path, {
      ...options,
      query: { ...options.query, list: 'true' },
    })
  }

  async request<D>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: RequestOptions = {},
  ): Promise<VaultResponse<D>> {
    const url = this.url(path, options.query)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.token !== undefined) headers['X-Vault-Token'] = options.token
    if (this.namespace !== undefined) headers['X-Vault-Namespace'] = this.namespace
    // Required by Vault Agent / Proxy listeners that set
    // `require_request_header`; ignored by the server itself.
    headers['X-Vault-Request'] = 'true'

    const init: RequestInit = { method, headers, credentials: 'omit', cache: 'no-store' }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }

    const timeout = AbortSignal.timeout(this.timeoutMs)
    init.signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (cause) {
      throw transportError(cause, path, options.signal, timeout)
    }

    const text = await response.text()
    const body = text === '' ? null : safeJson(text)

    if (!response.ok) {
      const errors = extractErrors(body)
      const message = errors.length > 0 ? errors.join('; ') : `HTTP ${response.status}`
      throw new VaultError(kindForStatus(response.status), message, {
        status: response.status,
        path,
        errors,
      })
    }

    // 204 No Content is a success with nothing to say.
    if (body === null) return { data: null, auth: null }

    if (typeof body !== 'object') {
      throw new VaultError('protocol', 'Response is not a JSON object', {
        status: response.status,
        path,
      })
    }

    const envelope = body as Partial<VaultResponse<D>>
    return {
      ...envelope,
      data: envelope.data ?? null,
      auth: envelope.auth ?? null,
    }
  }

  private url(path: string, query?: Readonly<Record<string, string>>): string {
    const clean = path.replace(/^\/+/, '')
    const encoded = clean
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    const search = query ? `?${new URLSearchParams(query).toString()}` : ''
    return `${this.address}/v1/${encoded}${search}`
  }
}

/**
 * Accepts what a user types in a setup form and returns a canonical
 * origin, or throws.
 */
export function normaliseAddress(raw: string): string {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new VaultError('invalid', `Not a valid URL: ${trimmed}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new VaultError('invalid', `Unsupported scheme: ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new VaultError('invalid', 'Credentials must not be embedded in the address')
  }
  // Keep a path prefix: Vault behind a reverse proxy at /vault is common.
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  return `${url.origin}${path}`
}

function transportError(
  cause: unknown,
  path: string,
  callerSignal: AbortSignal | undefined,
  timeout: AbortSignal,
): VaultError {
  if (callerSignal?.aborted) return new VaultError('aborted', 'Request cancelled', { path, cause })
  if (timeout.aborted) return new VaultError('timeout', 'Vault did not answer in time', { path, cause })
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new VaultError('network', `Cannot reach Vault: ${detail}`, { path, cause })
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function extractErrors(body: unknown): string[] {
  if (body !== null && typeof body === 'object' && 'errors' in body) {
    const { errors } = body as { errors: unknown }
    if (Array.isArray(errors)) {
      return errors
        .filter((e): e is string => typeof e === 'string')
        .map(tidyError)
        .filter((e) => e !== '')
    }
  }
  if (typeof body === 'string' && body.trim() !== '') return [body.trim()]
  return []
}

/** Vault wraps multierrors as "1 error occurred:\n\t* permission denied\n\n". */
function tidyError(message: string): string {
  const bullets = [...message.matchAll(/^\s*\*\s*(.+)$/gm)].map((m) => (m[1] ?? '').trim())
  return bullets.length > 0 ? bullets.join('; ') : message.trim()
}
