import { describe, expect, test } from 'vitest'
import { RpcError } from './messaging'
import { MatchQuality } from '../../core/types'
import { describeError, formatRelativeTime, qualityLabel } from './format'

describe('qualityLabel', () => {
  test.each([
    [MatchQuality.Exact, 'Exact match'],
    [MatchQuality.Host, 'This site'],
    [MatchQuality.Subdomain, 'Related subdomain'],
    [MatchQuality.Domain, 'Same domain'],
  ])('%s', (quality, label) => {
    expect(qualityLabel(quality)).toBe(label)
  })
})

describe('describeError', () => {
  test('maps known kinds to a friendly sentence', () => {
    expect(describeError(new RpcError('locked', 'x'))).toBe('Unlock first.')
    expect(describeError(new RpcError('permission', 'x'))).toBe('Vault denied access to this secret.')
  })

  test('shows the message verbatim for config errors', () => {
    expect(describeError(new RpcError('config', 'auth.username: required'))).toBe('auth.username: required')
  })

  test('falls back to the raw message for an unknown kind', () => {
    expect(describeError(new RpcError('mystery', 'raw detail'))).toBe('raw detail')
  })

  test('plain errors and non-errors', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError('nope')).toBe('Something went wrong')
    expect(describeError(null)).toBe('Something went wrong')
  })
})

describe('formatRelativeTime', () => {
  const now = 1_000_000_000

  test.each([
    [now - 1_000, 'just now'],
    [now - 30_000, '30s ago'],
    [now - 90_000, '2m ago'],
    [now - 2 * 3_600_000, '2h ago'],
    [now - 3 * 86_400_000, '3d ago'],
  ])('%i -> %s', (epochMs, label) => {
    expect(formatRelativeTime(epochMs, now)).toBe(label)
  })
})
