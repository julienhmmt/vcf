// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

const saveConfig = vi.fn()
const getConfig = vi.fn()
const login = vi.fn()
const permissionsRequest = vi.fn(async () => true)
const loadDraftMock = vi.fn(async () => ({}))
const saveDraftMock = vi.fn(async () => undefined)
const clearDraftMock = vi.fn(async () => undefined)

vi.mock('wxt/browser', () => ({ browser: { permissions: { request: permissionsRequest } } }))
vi.mock('../../ui/lib/rpc', () => ({ rpc: { saveConfig, getConfig, login } }))
vi.mock('../../ui/lib/draft', () => ({
  loadDraft: loadDraftMock,
  saveDraft: saveDraftMock,
  clearDraft: clearDraftMock,
}))
vi.mock('../../ui/lib/status.svelte', () => ({ statusStore: { status: null, refresh: vi.fn() } }))

const { default: Wizard } = await import('./Wizard.svelte')

describe('Wizard', () => {
  test('validates the server step before moving on', async () => {
    const onDone = vi.fn()
    render(Wizard, { onDone })

    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the Vault address.')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  test('userpass requires a username', async () => {
    render(Wizard, { onDone: vi.fn() })
    await userEvent.type(screen.getByLabelText('Address'), 'https://vault.example.net')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a username.')
  })

  test('requests the host permission, saves the config, then shows sign-in', async () => {
    getConfig.mockResolvedValueOnce({ auth: { method: 'userpass', username: 'julien' } })
    render(Wizard, { onDone: vi.fn() })

    await userEvent.type(screen.getByLabelText('Address'), 'https://vault.example.net:8200')
    await userEvent.type(screen.getByLabelText('Username'), 'julien')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => expect(permissionsRequest).toHaveBeenCalledWith({ origins: ['https://vault.example.net:8200/*'] }))
    expect(saveConfig).toHaveBeenCalledWith({
      address: 'https://vault.example.net:8200',
      auth: { method: 'userpass', username: 'julien' },
    })
    expect(clearDraftMock).toHaveBeenCalled()
    await screen.findByText('julien')
  })

  test('a declined permission blocks the flow', async () => {
    permissionsRequest.mockResolvedValueOnce(false)
    render(Wizard, { onDone: vi.fn() })

    await userEvent.type(screen.getByLabelText('Address'), 'https://vault.example.net')
    await userEvent.type(screen.getByLabelText('Username'), 'julien')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Access to the Vault server is required')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  test('approle and oidc show their own fields', async () => {
    render(Wizard, { onDone: vi.fn() })
    await userEvent.selectOptions(screen.getByLabelText('Authentication method'), 'AppRole')
    expect(screen.getByLabelText('Role ID')).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Authentication method'), 'OIDC')
    expect(screen.getByLabelText('Role (optional)')).toBeInTheDocument()
    expect(screen.queryByLabelText('Role ID')).toBeNull()
  })

  test('back returns to the server step without losing entered values', async () => {
    getConfig.mockResolvedValueOnce({ auth: { method: 'token' } })
    render(Wizard, { onDone: vi.fn() })

    await userEvent.type(screen.getByLabelText('Address'), 'https://vault.example.net')
    await userEvent.selectOptions(screen.getByLabelText('Authentication method'), 'Token')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('button', { name: 'Back' })

    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Address')).toHaveValue('https://vault.example.net')
  })

  test('prefill takes priority over the stored draft', async () => {
    getConfig.mockResolvedValueOnce({ auth: { method: 'approle' } })
    render(Wizard, {
      prefill: { address: 'https://from-config.example.net', authMethod: 'approle', roleId: 'r1' },
      onDone: vi.fn(),
    })

    expect(await screen.findByLabelText('Address')).toHaveValue('https://from-config.example.net')
    expect(loadDraftMock).not.toHaveBeenCalled()
  })
})
