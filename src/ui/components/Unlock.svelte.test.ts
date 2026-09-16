// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

const getConfig = vi.fn()
const login = vi.fn()
const refresh = vi.fn()
vi.mock('../lib/rpc', () => ({ rpc: { getConfig, login } }))
vi.mock('../lib/status.svelte', () => ({ statusStore: { refresh } }))

const { default: Unlock } = await import('./Unlock.svelte')

describe('Unlock', () => {
  test('userpass: shows the configured username, submits the password', async () => {
    getConfig.mockResolvedValueOnce({ auth: { method: 'userpass', username: 'julien' } })
    login.mockResolvedValueOnce({ unlocked: true })
    render(Unlock)

    await screen.findByText('julien')
    await userEvent.type(screen.getByLabelText('Password'), 'secret-pw')
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    expect(login).toHaveBeenCalledWith({ method: 'userpass', password: 'secret-pw' })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  test('ldap uses the same form as userpass', async () => {
    getConfig.mockResolvedValueOnce({ auth: { method: 'ldap', username: 'j.doe' } })
    render(Unlock)
    await screen.findByText('j.doe')
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  test('approle: shows the role id, submits the secret id', async () => {
    getConfig.mockResolvedValueOnce({ auth: { method: 'approle', roleId: 'vcf-role' } })
    login.mockResolvedValueOnce({ unlocked: true })
    render(Unlock)

    await screen.findByText('vcf-role')
    await userEvent.type(screen.getByLabelText('Secret ID'), 'vcf-secret')
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    expect(login).toHaveBeenCalledWith({ method: 'approle', secretId: 'vcf-secret' })
  })

  test('token: a single field, no identifying detail shown', async () => {
    getConfig.mockResolvedValueOnce({ auth: { method: 'token' } })
    login.mockResolvedValueOnce({ unlocked: true })
    render(Unlock)

    await userEvent.type(await screen.findByLabelText('Vault token'), 'root')
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    expect(login).toHaveBeenCalledWith({ method: 'token', token: 'root' })
  })

  test('oidc: a single button that drives the whole login', async () => {
    getConfig.mockResolvedValueOnce({ auth: { method: 'oidc' } })
    let resolveLogin: (value: unknown) => void = () => undefined
    login.mockImplementationOnce(() => new Promise((resolve) => (resolveLogin = resolve)))
    render(Unlock)

    const button = await screen.findByRole('button', { name: 'Sign in' })
    await userEvent.click(button)

    expect(login).toHaveBeenCalledWith({ method: 'oidc' })
    expect(screen.getByRole('button', { name: 'Waiting for sign-in…' })).toBeDisabled()

    resolveLogin({ unlocked: true })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  test('shows the error and lets the user try again', async () => {
    getConfig.mockResolvedValueOnce({ auth: { method: 'token' } })
    login.mockRejectedValueOnce(Object.assign(new Error('invalid username or password'), { kind: 'invalid' }))
    render(Unlock)

    await userEvent.type(await screen.findByLabelText('Vault token'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid username or password')
    expect(refresh).not.toHaveBeenCalled()
  })

  test('a config load failure is shown instead of a form', async () => {
    getConfig.mockRejectedValueOnce(new Error('cannot reach the worker'))
    render(Unlock)
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot reach the worker')
  })
})
