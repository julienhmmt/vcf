import { rpc } from './rpc'
import { describeError } from './format'
import type { Status } from '../../background/service'

/**
 * Shared, page-wide status. One instance per document (popup and
 * options never share a JS runtime), refreshed after every action
 * that can change it rather than polled on a timer.
 */
class StatusStore {
  status = $state<Status | null>(null)
  loading = $state(true)
  error = $state<string | null>(null)

  async refresh(): Promise<Status | null> {
    this.loading = true
    try {
      this.status = await rpc.status()
      this.error = null
    } catch (err) {
      this.error = describeError(err)
    } finally {
      this.loading = false
    }
    return this.status
  }
}

export const statusStore = new StatusStore()
