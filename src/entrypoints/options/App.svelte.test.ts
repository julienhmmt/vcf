// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

const status = vi.fn()
const getConfig = vi.fn()
const saveConfig = vi.fn()
const logout = vi.fn()
const permissionsRequest = vi.fn(async () => true)
const loadDraftMock = vi.fn(async () => ({}))
const saveDraftMock = vi.fn(async () => undefined)
const clearDraftMock = vi.fn(async () => undefined)

vi.mock('wxt/browser', () => ({ browser: { permissions: { request: permissionsRequest } } }))
vi.mock('../../ui/lib/rpc', () => ({ rpc: { status, getConfig, saveConfig, logout } }))
vi.mock('../../ui/lib/draft', () => ({
  loadDraft: loadDraftMock,
  saveDraft: saveDraftMock,
  clearDraft: clearDraftMock,
}))

const { default: App } = await import('./App.svelte')

const settingsConfig = {
  address: 'https://vault.example.net',
  namespace: '',
  auth: { method: 'userpass', username: 'julien', mount: 'userpass' },
  mounts: { mode: 'auto' },
  lockAfterMinutes: 30,
  refreshEveryMinutes: 15,
}

describe('options App', () => {
  test('no config: shows the setup wizard', async () => {
    getConfig.mockResolvedValueOnce(null)
    status.mockResolvedValueOnce({ configured: false, unlocked: false, index: { count: 0, builtAt: null, problems: 0 } })
    render(App)
    expect(await screen.findByLabelText('Address')).toBeInTheDocument()
  })

  test('existing config: shows settings', async () => {
    getConfig.mockResolvedValueOnce(settingsConfig)
    status.mockResolvedValueOnce({ configured: true, unlocked: false, index: { count: 0, builtAt: null, problems: 0 } })
    render(App)
    expect(await screen.findByText('https://vault.example.net')).toBeInTheDocument()
  })

  test('a load failure is shown', async () => {
    getConfig.mockRejectedValueOnce(new Error('offline'))
    status.mockResolvedValueOnce({ configured: false, unlocked: false, index: { count: 0, builtAt: null, problems: 0 } })
    render(App)
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
  })

  test('reconfigure from settings switches back to the wizard, prefilled', async () => {
    getConfig.mockResolvedValueOnce(settingsConfig)
    status.mockResolvedValueOnce({ configured: true, unlocked: false, index: { count: 0, builtAt: null, problems: 0 } })
    render(App)

    await userEvent.click(await screen.findByRole('button', { name: 'Reconfigure' }))
    expect(await screen.findByLabelText('Address')).toHaveValue('https://vault.example.net')
    expect(loadDraftMock).not.toHaveBeenCalled()
  })

  test('finishing the wizard reloads and lands on settings', async () => {
    getConfig.mockResolvedValueOnce(null)
    status.mockResolvedValueOnce({ configured: false, unlocked: true, index: { count: 0, builtAt: null, problems: 0 } })
    render(App)

    await userEvent.type(await screen.findByLabelText('Address'), 'https://vault.example.net')
    await userEvent.type(screen.getByLabelText('Username'), 'julien')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))

    // statusStore already reports unlocked from the initial load, so the
    // wizard's own effect advances straight past the sign-in step.
    await screen.findByRole('button', { name: 'Continue' })

    getConfig.mockResolvedValueOnce(settingsConfig)
    status.mockResolvedValueOnce({ configured: true, unlocked: true, index: { count: 0, builtAt: null, problems: 0 } })
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('https://vault.example.net')).toBeInTheDocument()
  })
})
