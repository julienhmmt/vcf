/**
 * Re-scans the page for login forms after it changes. SPA login
 * screens routinely render their form after the initial load with no
 * navigation event, so a one-shot scan on `document_idle` isn't
 * enough. Debounced and scoped to `document.body` rather than
 * re-scanning the whole DOM on every mutation.
 */
import { detectLoginForms } from './detect'
import type { LoginFormFields } from './detect'

export interface WatchOptions {
  readonly debounceMs?: number
  readonly root?: ParentNode
  readonly target?: Node
}

/** Starts watching; call the returned function to stop. */
export function watchForLoginForms(onForms: (forms: LoginFormFields[]) => void, options: WatchOptions = {}): () => void {
  const debounceMs = options.debounceMs ?? 250
  const root = options.root ?? document
  const target = options.target ?? document.body
  let timer: ReturnType<typeof setTimeout> | undefined

  const scan = () => onForms(detectLoginForms(root))
  scan()

  const observer = new MutationObserver(() => {
    clearTimeout(timer)
    timer = setTimeout(scan, debounceMs)
  })
  observer.observe(target, { childList: true, subtree: true })

  return () => {
    clearTimeout(timer)
    observer.disconnect()
  }
}
