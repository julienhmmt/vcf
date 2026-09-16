// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { MatchQuality } from '../../core/types'
import { RpcError } from '../../ui/lib/messaging'

const matchesForTab = vi.fn()
const fill = vi.fn()
vi.mock('../../ui/lib/rpc', () => ({ rpc: { matchesForTab, fill } }))

const { default: Picker } = await import('./Picker.svelte')

const gitlab = { mount: 'secret', path: 'perso/gitlab', title: 'GitLab interne', quality: MatchQuality.Host, downgrade: false }
const legacy = { mount: 'legacy', path: 'sites/example.org', title: 'example.org', quality: MatchQuality.Domain, downgrade: true }

describe('Picker', () => {
  test('lists candidates ranked by match quality label', async () => {
    matchesForTab.mockResolvedValueOnce({ unlocked: true, candidates: [gitlab, legacy] })
    render(Picker, { tabId: 7 })

    expect(await screen.findByText('GitLab interne')).toBeInTheDocument()
    expect(screen.getByText('This site')).toBeInTheDocument()
    expect(screen.getByText('example.org')).toBeInTheDocument()
    expect(screen.getByText('Same domain')).toBeInTheDocument()
    expect(matchesForTab).toHaveBeenCalledWith(7)
  })

  test('no matches', async () => {
    matchesForTab.mockResolvedValueOnce({ unlocked: true, candidates: [] })
    render(Picker, { tabId: 7 })
    expect(await screen.findByText('No credential matches this page.')).toBeInTheDocument()
  })

  test('a load failure is shown', async () => {
    matchesForTab.mockRejectedValueOnce(new RpcError('locked', 'x'))
    render(Picker, { tabId: 7 })
    expect(await screen.findByRole('alert')).toHaveTextContent('Unlock first.')
  })

  test('fill: explicit click, exact request, shows confirmation', async () => {
    matchesForTab.mockResolvedValueOnce({ unlocked: true, candidates: [gitlab] })
    fill.mockResolvedValueOnce({ username: true, password: true, totp: false })
    render(Picker, { tabId: 7 })

    await userEvent.click(await screen.findByRole('button', { name: 'Fill' }))

    expect(fill).toHaveBeenCalledWith({
      tabId: 7,
      mount: 'secret',
      path: 'perso/gitlab',
      allowDowngrade: false,
    })
    expect(await screen.findByRole('button', { name: 'Filled ✓' })).toBeInTheDocument()
  })

  test('a scheme downgrade blocks the fill until confirmed', async () => {
    matchesForTab.mockResolvedValueOnce({ unlocked: true, candidates: [legacy] })
    fill.mockRejectedValueOnce(new RpcError('downgrade', 'nope'))
    render(Picker, { tabId: 7 })

    await userEvent.click(await screen.findByRole('button', { name: 'Fill' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This page is not using https')
    expect(fill).toHaveBeenCalledTimes(1)

    fill.mockResolvedValueOnce({ username: true, password: true, totp: false })
    await userEvent.click(screen.getByRole('button', { name: 'Fill anyway' }))

    expect(fill).toHaveBeenLastCalledWith({
      tabId: 7,
      mount: 'legacy',
      path: 'sites/example.org',
      allowDowngrade: true,
    })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  test('cancelling a downgrade warning never fills', async () => {
    matchesForTab.mockResolvedValueOnce({ unlocked: true, candidates: [legacy] })
    fill.mockRejectedValueOnce(new RpcError('downgrade', 'nope'))
    render(Picker, { tabId: 7 })

    await userEvent.click(await screen.findByRole('button', { name: 'Fill' }))
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(fill).toHaveBeenCalledTimes(1)
  })

  test('a plain fill failure is shown without offering a retry', async () => {
    matchesForTab.mockResolvedValueOnce({ unlocked: true, candidates: [gitlab] })
    fill.mockRejectedValueOnce(new RpcError('server', 'boom'))
    render(Picker, { tabId: 7 })

    await userEvent.click(await screen.findByRole('button', { name: 'Fill' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Vault returned an unexpected error.')
  })
})
