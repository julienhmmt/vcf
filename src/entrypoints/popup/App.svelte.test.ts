// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

const status = vi.fn()
const lock = vi.fn()
const refreshIndex = vi.fn()
const getConfig = vi.fn()
const openOptionsPage = vi.fn()
const tabsQuery = vi.fn(async () => [{ id: 42 }])
const matchesForTab = vi.fn(async () => ({ unlocked: true, candidates: [] }))

vi.mock('wxt/browser', () => ({
  browser: { runtime: { openOptionsPage }, tabs: { query: tabsQuery } },
}))
vi.mock('../../ui/lib/rpc', () => ({ rpc: { status, lock, refreshIndex, getConfig, matchesForTab } }))

const { default: App } = await import('./App.svelte')

const unlockedStatus = {
  configured: true,
  unlocked: true,
  index: { count: 3, builtAt: Date.now(), problems: 0 },
}

describe('popup App', () => {
  test('not configured: offers to open setup', async () => {
    status.mockResolvedValueOnce({ configured: false, unlocked: false, index: { count: 0, builtAt: null, problems: 0 } })
    render(App)

    await userEvent.click(await screen.findByRole('button', { name: 'Open setup' }))
    expect(openOptionsPage).toHaveBeenCalled()
  })

  test('configured but locked: shows the unlock form', async () => {
    status.mockResolvedValueOnce({ configured: true, unlocked: false, index: { count: 0, builtAt: null, problems: 0 } })
    getConfig.mockResolvedValueOnce({ auth: { method: 'token' } })
    render(App)
    expect(await screen.findByLabelText('Vault token')).toBeInTheDocument()
  })

  test('unlocked: shows the picker, index status and a lock button', async () => {
    status.mockResolvedValueOnce(unlockedStatus)
    render(App)

    await screen.findByText((text) => text.includes('3 credentials') && text.includes('updated just now'))
    expect(matchesForTab).toHaveBeenCalledWith(42)

    status.mockResolvedValueOnce({ ...unlockedStatus, unlocked: false })
    getConfig.mockResolvedValueOnce({ auth: { method: 'token' } })
    lock.mockResolvedValueOnce(undefined)
    await userEvent.click(screen.getByRole('button', { name: 'Lock' }))
    expect(lock).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull())
  })

  test('singular credential count', async () => {
    status.mockResolvedValueOnce({ ...unlockedStatus, index: { count: 1, builtAt: null, problems: 0 } })
    render(App)
    expect(await screen.findByText('1 credential')).toBeInTheDocument()
  })

  test('surfaces inaccessible-credential problems', async () => {
    status.mockResolvedValueOnce({ ...unlockedStatus, index: { count: 3, builtAt: null, problems: 2 } })
    render(App)
    expect(await screen.findByText((text) => text.includes('2 inaccessible'))).toBeInTheDocument()
  })

  test('refresh button triggers an index rebuild', async () => {
    status.mockResolvedValueOnce(unlockedStatus)
    refreshIndex.mockResolvedValueOnce({ count: 4, problems: 0, builtAt: Date.now() })
    status.mockResolvedValueOnce(unlockedStatus)
    render(App)

    await userEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
    expect(refreshIndex).toHaveBeenCalled()
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
  })

  test('a status failure is shown', async () => {
    status.mockRejectedValueOnce(new Error('offline'))
    render(App)
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
  })
})
