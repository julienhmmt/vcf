import type { FetchLike } from './http'

export interface FakeReply {
  readonly status?: number
  readonly body?: unknown
}

export interface RecordedCall {
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly headers: Record<string, string>
  readonly body: unknown
}

type Handler = FakeReply | ((call: RecordedCall) => FakeReply)

/**
 * Minimal in-memory Vault for unit tests. Routes are `METHOD path`,
 * path without `/v1/` and without query, e.g. `GET secret/metadata/`.
 * With `?list=true`, the route is `LIST <path>`.
 */
export function fakeVault(routes: Record<string, Handler>): {
  fetch: FetchLike
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    const path = decodeURIComponent(url.pathname.replace(/^.*?\/v1\//, ''))
    const listing = url.searchParams.get('list') === 'true'
    const method = listing ? 'LIST' : (init.method ?? 'GET')
    const call: RecordedCall = {
      method,
      path,
      query: url.searchParams,
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)

    const handler = routes[`${method} ${path}`]
    if (handler === undefined) {
      return new Response(JSON.stringify({ errors: [] }), { status: 404 })
    }
    const reply = typeof handler === 'function' ? handler(call) : handler
    const status = reply.status ?? 200
    const text =
      reply.body === undefined ? null : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    return new Response(status === 204 ? null : text, { status })
  }
  return { fetch, calls }
}

export const denied: FakeReply = {
  status: 403,
  body: { errors: ['1 error occurred:\n\t* permission denied\n\n'] },
}

export function authReply(token: string, extra: Record<string, unknown> = {}): FakeReply {
  return {
    body: {
      data: null,
      auth: {
        client_token: token,
        accessor: `acc-${token}`,
        policies: ['default', 'vcf-filler'],
        token_policies: ['default', 'vcf-filler'],
        lease_duration: 3600,
        renewable: true,
        entity_id: 'ent-1',
        ...extra,
      },
    },
  }
}

export function listReply(keys: string[]): FakeReply {
  return { body: { data: { keys } } }
}
