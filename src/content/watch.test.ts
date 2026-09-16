// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { watchForLoginForms } from './watch'

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
})

describe('watchForLoginForms', () => {
  test('scans once immediately', () => {
    document.body.innerHTML = '<input type="password">'
    const onForms = vi.fn()
    const stop = watchForLoginForms(onForms, { debounceMs: 50 })
    expect(onForms).toHaveBeenCalledTimes(1)
    expect(onForms.mock.calls[0]?.[0]).toHaveLength(1)
    stop()
  })

  test('re-scans, debounced, after a DOM mutation', async () => {
    const onForms = vi.fn()
    const stop = watchForLoginForms(onForms, { debounceMs: 50 })
    expect(onForms).toHaveBeenCalledTimes(1)

    const form = document.createElement('form')
    form.innerHTML = '<input type="password">'
    document.body.appendChild(form)

    // MutationObserver callbacks run as a microtask; flush it before
    // asserting the debounce timer was armed.
    await vi.waitFor(() => expect(onForms).toHaveBeenCalledTimes(1))
    vi.advanceTimersByTime(49)
    expect(onForms).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(onForms).toHaveBeenCalledTimes(2)
    expect(onForms.mock.calls[1]?.[0]).toHaveLength(1)
    stop()
  })

  test('coalesces a burst of mutations into one re-scan', async () => {
    const onForms = vi.fn()
    const stop = watchForLoginForms(onForms, { debounceMs: 50 })

    for (let i = 0; i < 5; i++) {
      document.body.appendChild(document.createElement('div'))
    }
    // MutationObserver callbacks land as a microtask, batched per
    // turn regardless of how many mutations happened synchronously.
    await Promise.resolve()
    vi.advanceTimersByTime(50)
    expect(onForms).toHaveBeenCalledTimes(2)
    stop()
  })

  test('stop() disconnects the observer', async () => {
    const onForms = vi.fn()
    const stop = watchForLoginForms(onForms, { debounceMs: 50 })
    stop()

    document.body.appendChild(document.createElement('div'))
    await Promise.resolve()
    vi.advanceTimersByTime(200)
    expect(onForms).toHaveBeenCalledTimes(1)
  })
})
