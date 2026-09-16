import { browser } from 'wxt/browser'
import type { Request, Response } from '../../background/router'

/**
 * Every failure the service worker can report, surfaced as a normal
 * exception so components can `catch` it and read `.kind`.
 */
export class RpcError extends Error {
  override readonly name = 'RpcError'
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message)
  }
}

/** A freshly woken service worker hasn't registered its listener yet. */
const WAKE_RETRY_DELAY_MS = 150

/**
 * Sends one request to the service worker and unwraps the response.
 *
 * Never called with an untyped payload: every call site goes through
 * the typed helpers below, so a mismatched message shape is a
 * typecheck failure, not a runtime one.
 */
export async function send<T>(request: Request): Promise<T> {
  const response = await sendWithRetry(request)
  if (!response.ok) throw new RpcError(response.error.kind, response.error.message)
  return response.value as T
}

async function sendWithRetry(request: Request, attempt = 0): Promise<Response> {
  let response: Response | undefined
  try {
    response = (await browser.runtime.sendMessage(request)) as Response | undefined
  } catch {
    response = undefined
  }
  if (response !== undefined) return response
  if (attempt > 0) {
    throw new RpcError('no_receiver', 'The extension background is not responding')
  }
  await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_DELAY_MS))
  return sendWithRetry(request, attempt + 1)
}
