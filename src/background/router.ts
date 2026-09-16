import { ServiceError, toWireError } from './errors'
import type { WireError } from './errors'
import type { BackgroundService, LoginInput } from './service'

/**
 * Message protocol between extension pages / content scripts and the
 * service worker. Every request is validated structurally here; the
 * service never sees an unchecked object.
 */
export type Request =
  | { readonly type: 'status' }
  | { readonly type: 'probe'; readonly address: string; readonly namespace?: string }
  | { readonly type: 'config/save'; readonly config: unknown }
  | { readonly type: 'login'; readonly input: LoginInput }
  | { readonly type: 'logout' }
  | { readonly type: 'lock' }
  | { readonly type: 'index/refresh' }
  /** From the popup: candidates for a tab the user is looking at. */
  | { readonly type: 'matches/tab'; readonly tabId: number }
  /** From a content script: candidates for its own frame. */
  | { readonly type: 'matches/frame'; readonly userAction: boolean }
  | {
      readonly type: 'fill'
      readonly mount: string
      readonly path: string
      readonly allowDowngrade: boolean
      /** Required from pages, ignored from content scripts. */
      readonly tabId?: number
    }

export type Response<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WireError }

/** The subset of `runtime.MessageSender` we rely on. */
export interface Sender {
  readonly id?: string | undefined
  readonly url?: string | undefined
  readonly origin?: string | undefined
  readonly tab?: { readonly id?: number | undefined } | undefined
  readonly frameId?: number | undefined
}

export interface RouterDeps {
  readonly service: BackgroundService
  readonly runtimeId: string
  readonly extensionOrigin: string
  tabUrl(tabId: number): Promise<string | undefined>
}

type Origin = 'page' | 'content'

/** Which requests each kind of sender may make. */
const ALLOWED: Readonly<Record<Request['type'], readonly Origin[]>> = {
  status: ['page', 'content'],
  probe: ['page'],
  'config/save': ['page'],
  login: ['page'],
  logout: ['page'],
  lock: ['page'],
  'index/refresh': ['page'],
  'matches/tab': ['page'],
  'matches/frame': ['content'],
  fill: ['page', 'content'],
}

export async function route(deps: RouterDeps, message: unknown, sender: Sender): Promise<Response> {
  try {
    const origin = classifySender(deps, sender)
    const request = parseRequest(message)
    if (!ALLOWED[request.type].includes(origin)) {
      throw new ServiceError('forbidden_sender', `${request.type} is not allowed from ${origin}`)
    }
    return { ok: true, value: await dispatch(deps, request, origin, sender) }
  } catch (error) {
    return { ok: false, error: toWireError(error) }
  }
}

async function dispatch(deps: RouterDeps, request: Request, origin: Origin, sender: Sender): Promise<unknown> {
  const { service } = deps
  switch (request.type) {
    case 'status': {
      const status = await service.status()
      // A content script only needs to know whether to offer a picker.
      return origin === 'page' ? status : { configured: status.configured, unlocked: status.unlocked }
    }
    case 'probe':
      return service.probe(request.address, request.namespace)
    case 'config/save':
      return service.saveConfig(request.config)
    case 'login':
      return service.login(request.input)
    case 'logout':
      return service.logout()
    case 'lock':
      return service.lock('user')
    case 'index/refresh': {
      const index = await service.refreshIndex()
      return { count: index.entries.length, problems: index.problems.length, builtAt: index.builtAt }
    }
    case 'matches/tab':
      return service.matches(await requireTabUrl(deps, request.tabId), true)
    case 'matches/frame':
      return service.matches(requireFrameUrl(sender), request.userAction)
    case 'fill': {
      const target =
        origin === 'content'
          ? { tabId: requireTabId(sender), frameId: sender.frameId ?? 0, frameUrl: requireFrameUrl(sender) }
          : await pageFillTarget(deps, request.tabId)
      return service.fill({
        ...target,
        mount: request.mount,
        path: request.path,
        allowDowngrade: request.allowDowngrade,
      })
    }
  }
}

/**
 * Only our own extension may talk to us. Extension pages are
 * recognised by origin; anything else with our id is a content script
 * and must come from a tab.
 */
export function classifySender(deps: Pick<RouterDeps, 'runtimeId' | 'extensionOrigin'>, sender: Sender): Origin {
  if (sender.id !== deps.runtimeId) throw new ServiceError('forbidden_sender', 'Unknown sender')
  // Compared as a prefix: `URL.origin` is "null" for extension schemes
  // in some engines.
  const fromExtension =
    sender.origin === deps.extensionOrigin ||
    (sender.origin === undefined && sender.url?.startsWith(`${deps.extensionOrigin}/`) === true)
  if (fromExtension) return 'page'
  if (sender.tab?.id !== undefined && sender.url !== undefined) return 'content'
  throw new ServiceError('forbidden_sender', 'Sender is neither an extension page nor a tab')
}

/**
 * From the popup, the top frame of the tab is filled. The URL comes
 * from the browser, never from the message.
 */
async function pageFillTarget(deps: RouterDeps, tabId: number | undefined) {
  if (tabId === undefined) throw new ServiceError('bad_request', 'tabId is required')
  return { tabId, frameId: 0, frameUrl: await requireTabUrl(deps, tabId) }
}

async function requireTabUrl(deps: RouterDeps, tabId: number): Promise<string> {
  const url = await deps.tabUrl(tabId)
  if (url === undefined) throw new ServiceError('unsupported_page', 'Cannot see this tab')
  return url
}

function requireFrameUrl(sender: Sender): string {
  if (sender.url === undefined) throw new ServiceError('forbidden_sender', 'Sender has no URL')
  return sender.url
}

function requireTabId(sender: Sender): number {
  const id = sender.tab?.id
  if (id === undefined) throw new ServiceError('forbidden_sender', 'Sender has no tab')
  return id
}

// --- structural validation --------------------------------------------

export function parseRequest(message: unknown): Request {
  const m = record(message)
  switch (m.type) {
    case 'status':
    case 'logout':
    case 'lock':
    case 'index/refresh':
      return { type: m.type }
    case 'probe':
      return {
        type: 'probe',
        address: string(m.address),
        ...(m.namespace === undefined ? {} : { namespace: string(m.namespace) }),
      }
    case 'config/save':
      return { type: 'config/save', config: m.config }
    case 'login':
      return { type: 'login', input: parseLogin(m.input) }
    case 'matches/tab':
      return { type: 'matches/tab', tabId: integer(m.tabId) }
    case 'matches/frame':
      return { type: 'matches/frame', userAction: m.userAction === true }
    case 'fill':
      return {
        type: 'fill',
        mount: string(m.mount),
        path: string(m.path),
        allowDowngrade: m.allowDowngrade === true,
        ...(m.tabId === undefined ? {} : { tabId: integer(m.tabId) }),
      }
    default:
      throw bad()
  }
}

function parseLogin(input: unknown): LoginInput {
  const m = record(input)
  switch (m.method) {
    case 'token':
      return { method: 'token', token: string(m.token) }
    case 'userpass':
    case 'ldap':
      return { method: m.method, password: string(m.password) }
    case 'approle':
      return { method: 'approle', secretId: m.secretId === undefined ? '' : string(m.secretId) }
    case 'oidc':
      return { method: 'oidc' }
    default:
      throw bad()
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad()
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw bad()
  return value
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw bad()
  return value
}

function bad(): ServiceError {
  return new ServiceError('bad_request', 'Malformed message')
}
