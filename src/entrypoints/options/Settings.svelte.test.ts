// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

const saveConfig = vi.fn()
const logout = vi.fn()
const refresh = vi.fn()

vi.mock('../../ui/lib/rpc', () => ({ rpc: { saveConfig, logout } }))

let statusValue: unknown = { unlocked: true, expiresAt: null, lockAt: null }
vi.mock('../../ui/lib/status.svelte', () => ({
  statusStore: {
    get status() {
      return statusValue
    },
    refresh,
  },
}))

const { default: Settings } = await import('./Settings.svelte')

const userpassConfig = {
  address: 'https://vault.example.net',
  namespace: '',
  auth: { method: 'userpass', username: 'julien', mount: 'userpass' },
  mounts: { mode: 'auto' },
  lockAfterMinutes: 30,
  refreshEveryMinutes: 15,
}

describe('Settings', () => {
  test('shows the current connection', async () => {
    render(Settings, { config: userpassConfig, onReconfigure: vi.fn() })
    expect(screen.getByText('https://vault.example.net')).toBeInTheDocument()
    expect(screen.getByText('Username & password')).toBeInTheDocument()
  })

  test('saves edited preferences, keeping address and auth untouched', async () => {
    saveConfig.mockResolvedValueOnce({ unlocked: true })
    render(Settings, { config: userpassConfig, onReconfigure: vi.fn() })

    const lockInput = screen.getByLabelText('Lock after inactivity (minutes)')
    await userEvent.clear(lockInput)
    await userEvent.type(lockInput, '10')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(saveConfig).toHaveBeenCalledWith({
      address: 'https://vault.example.net',
      auth: userpassConfig.auth,
      mounts: { mode: 'auto' },
      lockAfterMinutes: 10,
      refreshEveryMinutes: 15,
    })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
  })

  test('switching to manual mounts requires at least one path', async () => {
    render(Settings, { config: userpassConfig, onReconfigure: vi.fn() })
    await userEvent.click(screen.getByLabelText('Use only these mounts'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('at least one mount path')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  test('manual mounts parses the comma-separated list', async () => {
    saveConfig.mockResolvedValueOnce({ unlocked: true })
    render(Settings, { config: userpassConfig, onReconfigure: vi.fn() })
    await userEvent.click(screen.getByLabelText('Use only these mounts'))
    await userEvent.type(screen.getByPlaceholderText('secret, team'), ' secret ,team ,, ')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ mounts: { mode: 'manual', paths: ['secret', 'team'] } }),
    )
  })

  test('sign out is only offered while unlocked', async () => {
    statusValue = { unlocked: false, expiresAt: null, lockAt: null }
    render(Settings, { config: userpassConfig, onReconfigure: vi.fn() })
    expect(screen.queryByRole('button', { name: /Sign out/ })).toBeNull()
    statusValue = { unlocked: true, expiresAt: null, lockAt: null }
  })

  test('reconfigure hands the current non-secret config back up', async () => {
    const onReconfigure = vi.fn()
    render(Settings, { config: userpassConfig, onReconfigure })
    await userEvent.click(screen.getByRole('button', { name: 'Reconfigure' }))
    expect(onReconfigure).toHaveBeenCalledWith({
      address: 'https://vault.example.net',
      namespace: '',
      authMethod: 'userpass',
      mount: 'userpass',
      username: 'julien',
      roleId: '',
      role: '',
    })
  })

  test('a save failure is shown', async () => {
    saveConfig.mockRejectedValueOnce(new Error('rejected'))
    render(Settings, { config: userpassConfig, onReconfigure: vi.fn() })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('rejected')
  })
})
