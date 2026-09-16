/**
 * The two messages a content script may send (see docs/messaging.md):
 * candidates for its own frame, and a fill. Both omit `tabId` — the
 * router derives the target frame from the sender, never from the
 * message, so a compromised page script relaying a forged message
 * can't point a fill at a different tab.
 */
import { send } from '../ui/lib/messaging'
import type { MatchResult } from '../background/service'
import type { FillOutcome } from '../ui/lib/rpc'

export const contentRpc = {
  /** `userAction: false` on page load — this must not count as activity. */
  matchesForFrame: (userAction: boolean) => send<MatchResult>({ type: 'matches/frame', userAction }),

  fill: (params: { mount: string; path: string; allowDowngrade: boolean }) =>
    send<FillOutcome>({ type: 'fill', ...params }),
}
