import { describe, expect, test } from 'vitest'
import {
  MIN_RENEW_DELAY_MS,
  expiresAt,
  isExpired,
  nextRenewalAt,
  renewalOutcome,
} from './renewal'

const t0 = 1_000_000

describe('expiry', () => {
  test('root-like tokens never expire', () => {
    const lease = { ttl: 0, renewable: false, observedAt: t0 }
    expect(expiresAt(lease)).toBeNull()
    expect(isExpired(lease, t0 + 1e12)).toBe(false)
  })

  test('expires ttl seconds after observation', () => {
    const lease = { ttl: 60, renewable: true, observedAt: t0 }
    expect(expiresAt(lease)).toBe(t0 + 60_000)
    expect(isExpired(lease, t0 + 59_999)).toBe(false)
    expect(isExpired(lease, t0 + 60_000)).toBe(true)
  })
})

describe('nextRenewalAt', () => {
  test('two thirds into the ttl', () => {
    expect(nextRenewalAt({ ttl: 3600, renewable: true, observedAt: t0 })).toBe(t0 + 2_400_000)
  })

  test('not for non-renewable or non-expiring tokens', () => {
    expect(nextRenewalAt({ ttl: 3600, renewable: false, observedAt: t0 })).toBeNull()
    expect(nextRenewalAt({ ttl: 0, renewable: true, observedAt: t0 })).toBeNull()
  })

  test('respects the floor but never goes past expiry', () => {
    expect(nextRenewalAt({ ttl: 6, renewable: true, observedAt: t0 })).toBe(t0 + MIN_RENEW_DELAY_MS)
    expect(nextRenewalAt({ ttl: 2, renewable: true, observedAt: t0 })).toBe(t0 + 2_000)
  })
})

describe('renewalOutcome', () => {
  const before = { ttl: 3600, renewable: true, observedAt: t0 }

  test('extended when expiry moves forward', () => {
    expect(renewalOutcome(before, { ttl: 3600, renewable: true, observedAt: t0 + 2_400_000 })).toBe('extended')
  })

  test('capped when expiry stays put', () => {
    expect(renewalOutcome(before, { ttl: 1200, renewable: true, observedAt: t0 + 2_400_000 })).toBe('capped')
  })

  test('non-expiring tokens count as extended', () => {
    expect(renewalOutcome({ ...before, ttl: 0 }, before)).toBe('extended')
  })
})
