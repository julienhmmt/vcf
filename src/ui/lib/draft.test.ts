import { describe, expect, test, vi } from 'vitest'

const data = new Map<string, unknown>()
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: data.get(key) }),
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) data.set(k, v)
        },
        remove: async (key: string) => {
          data.delete(key)
        },
      },
    },
  },
}))

const { clearDraft, loadDraft, saveDraft } = await import('./draft')

describe('wizard draft', () => {
  test('empty by default', async () => {
    expect(await loadDraft()).toEqual({})
  })

  test('round-trips and clears', async () => {
    await saveDraft({ address: 'https://v', authMethod: 'userpass', username: 'j' })
    expect(await loadDraft()).toEqual({ address: 'https://v', authMethod: 'userpass', username: 'j' })

    await clearDraft()
    expect(await loadDraft()).toEqual({})
  })

  test('never carries a password or secret id field', async () => {
    await saveDraft({ address: 'https://v', authMethod: 'approle', roleId: 'r' })
    const stored = JSON.stringify(await loadDraft())
    expect(stored).not.toContain('password')
    expect(stored).not.toContain('secretId')
  })
})
