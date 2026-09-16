// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BadgeController } from './badge'
import { RpcError } from '../ui/lib/messaging'
import { MatchQuality } from '../core/types'
import type { Candidate } from '../background/service'

const candidate: Candidate = {
  mount: 'secret',
  path: 'perso/gitlab',
  title: 'GitLab',
  quality: MatchQuality.Exact,
  downgrade: false,
}

function toggle(container: HTMLElement): void {
  container.querySelector<HTMLButtonElement>('.vcf-toggle')!.click()
}

function fillButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.vcf-panel ul button'))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BadgeController', () => {
  test('renders only the toggle button when closed', () => {
    const container = document.createElement('div')
    new BadgeController(container, { listCandidates: vi.fn(), fill: vi.fn() })
    expect(container.querySelector('.vcf-toggle')).not.toBeNull()
    expect(container.querySelector('.vcf-panel')).toBeNull()
  })

  test('opening loads and lists candidates', async () => {
    const listCandidates = vi.fn(async () => [candidate])
    const container = document.createElement('div')
    new BadgeController(container, { listCandidates, fill: vi.fn() })

    toggle(container)
    expect(container.querySelector('.vcf-panel')?.textContent).toContain('Looking for credentials')
    await vi.waitFor(() => expect(listCandidates).toHaveBeenCalled())
    await Promise.resolve()
    expect(container.textContent).toContain('GitLab')
  })

  test('toggling again closes the panel', async () => {
    const listCandidates = vi.fn(async () => [candidate])
    const container = document.createElement('div')
    new BadgeController(container, { listCandidates, fill: vi.fn() })

    toggle(container)
    await vi.waitFor(() => expect(container.textContent).toContain('GitLab'))
    toggle(container)
    expect(container.querySelector('.vcf-panel')).toBeNull()
  })

  test('empty candidates shows a hint', async () => {
    const container = document.createElement('div')
    new BadgeController(container, { listCandidates: async () => [], fill: vi.fn() })
    toggle(container)
    await vi.waitFor(() => expect(container.textContent).toContain('No credential matches'))
  })

  test('a listing failure is shown', async () => {
    const container = document.createElement('div')
    new BadgeController(container, {
      listCandidates: async () => {
        throw new RpcError('locked', 'nope')
      },
      fill: vi.fn(),
    })
    toggle(container)
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe('Unlock first.'))
  })

  test('picking a candidate fills it and shows a confirmation pulse', async () => {
    const fill = vi.fn(async () => undefined)
    const container = document.createElement('div')
    new BadgeController(container, { listCandidates: async () => [candidate], fill })
    toggle(container)
    await vi.waitFor(() => expect(fillButtons(container)).toHaveLength(1))

    fillButtons(container)[0]!.click()
    await vi.waitFor(() => expect(fill).toHaveBeenCalledWith(candidate, false))
    await vi.waitFor(() => expect(container.textContent).toContain('Filled'))

    vi.advanceTimersByTime(1500)
    expect(container.querySelector('.vcf-panel')).toBeNull()
  })

  test('a downgrade error asks for confirmation, then retries with allowDowngrade', async () => {
    const fill = vi.fn(async (_candidate: Candidate, allowDowngrade: boolean) => {
      if (!allowDowngrade) throw new RpcError('downgrade', 'nope')
    })
    const container = document.createElement('div')
    new BadgeController(container, { listCandidates: async () => [candidate], fill })
    toggle(container)
    await vi.waitFor(() => expect(fillButtons(container)).toHaveLength(1))

    fillButtons(container)[0]!.click()
    await vi.waitFor(() => expect(container.textContent).toContain('not using https'))
    expect(fill).toHaveBeenCalledTimes(1)

    container.querySelector<HTMLButtonElement>('.vcf-downgrade button')!.click()
    await vi.waitFor(() => expect(fill).toHaveBeenCalledTimes(2))
    expect(fill).toHaveBeenLastCalledWith(candidate, true)
    await vi.waitFor(() => expect(container.textContent).toContain('Filled'))
  })

  test('cancelling a downgrade confirmation returns to the list', async () => {
    const fill = vi.fn(async () => {
      throw new RpcError('downgrade', 'nope')
    })
    const container = document.createElement('div')
    new BadgeController(container, { listCandidates: async () => [candidate], fill })
    toggle(container)
    await vi.waitFor(() => expect(fillButtons(container)).toHaveLength(1))
    fillButtons(container)[0]!.click()
    await vi.waitFor(() => expect(container.textContent).toContain('not using https'))

    const [, cancelButton] = container.querySelectorAll<HTMLButtonElement>('.vcf-downgrade button')
    cancelButton!.click()
    expect(container.querySelector('.vcf-downgrade')).toBeNull()
    expect(fillButtons(container)).toHaveLength(1)
  })

  test('a plain fill failure is shown without a retry option', async () => {
    const fill = vi.fn(async () => {
      throw new RpcError('server', 'boom')
    })
    const container = document.createElement('div')
    new BadgeController(container, { listCandidates: async () => [candidate], fill })
    toggle(container)
    await vi.waitFor(() => expect(fillButtons(container)).toHaveLength(1))
    fillButtons(container)[0]!.click()
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('unexpected error'))
  })

  test('destroy clears the container and any pending timer', async () => {
    const fill = vi.fn(async () => undefined)
    const container = document.createElement('div')
    const badge = new BadgeController(container, { listCandidates: async () => [candidate], fill })
    toggle(container)
    await vi.waitFor(() => expect(fillButtons(container)).toHaveLength(1))
    fillButtons(container)[0]!.click()
    await vi.waitFor(() => expect(container.textContent).toContain('Filled'))

    badge.destroy()
    expect(container.innerHTML).toBe('')
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
  })
})
