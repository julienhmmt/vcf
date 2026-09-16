import { describe, expect, test, vi } from 'vitest'

const sendMessage = vi.fn()
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage } } }))

const { send, RpcError } = await import('./messaging')

describe('send', () => {
  test('unwraps a successful response', async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, value: 42 })
    await expect(send({ type: 'status' })).resolves.toBe(42)
    expect(sendMessage).toHaveBeenCalledWith({ type: 'status' })
  })

  test('throws an RpcError for a failure response', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: { kind: 'locked', message: 'Unlock first' } })
    const error = await send({ type: 'status' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({ kind: 'locked', message: 'Unlock first' })
  })

  test('retries once when the worker was asleep, then gives up', async () => {
    sendMessage.mockRejectedValueOnce(new Error('Could not establish connection'))
    sendMessage.mockResolvedValueOnce({ ok: true, value: 'awake' })
    await expect(send({ type: 'status' })).resolves.toBe('awake')
    expect(sendMessage).toHaveBeenCalledTimes(2)

    sendMessage.mockRejectedValueOnce(new Error('gone'))
    sendMessage.mockRejectedValueOnce(new Error('still gone'))
    const error = await send({ type: 'status' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'no_receiver' })
  })

  test('an undefined response (no listener) is treated the same as a rejection', async () => {
    sendMessage.mockResolvedValueOnce(undefined)
    sendMessage.mockResolvedValueOnce({ ok: true, value: 'ok' })
    await expect(send({ type: 'status' })).resolves.toBe('ok')
  })
})
