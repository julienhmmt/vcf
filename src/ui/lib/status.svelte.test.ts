import { describe, expect, test, vi } from 'vitest'

const status = vi.fn()
vi.mock('./rpc', () => ({ rpc: { status } }))

const { statusStore } = await import('./status.svelte')

describe('statusStore', () => {
  test('populates status on success', async () => {
    status.mockResolvedValueOnce({ configured: true, unlocked: false })
    const result = await statusStore.refresh()
    expect(result).toEqual({ configured: true, unlocked: false })
    expect(statusStore.status).toEqual({ configured: true, unlocked: false })
    expect(statusStore.error).toBeNull()
    expect(statusStore.loading).toBe(false)
  })

  test('records a friendly error and keeps the previous status', async () => {
    status.mockRejectedValueOnce(new Error('offline'))
    const result = await statusStore.refresh()
    expect(result).toEqual({ configured: true, unlocked: false })
    expect(statusStore.error).toBe('offline')
  })
})
