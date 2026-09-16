/**
 * RFC 6238 TOTP, on WebCrypto only (available in browsers and Node).
 *
 * Codes are computed where the seed lives — the service worker — so
 * the seed itself never reaches a page.
 */

export type TotpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512'

export interface TotpParams {
  readonly secret: Uint8Array
  readonly algorithm: TotpAlgorithm
  readonly digits: number
  readonly period: number
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function decodeBase32(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (clean === '') throw new Error('Empty TOTP secret')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const value = BASE32.indexOf(char)
    if (value === -1) throw new Error('TOTP secret is not base32')
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

const ALGORITHMS: Readonly<Record<string, TotpAlgorithm>> = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA512: 'SHA-512',
}

/** Accepts an `otpauth://totp/...` URI or a bare base32 secret. */
export function parseTotpSeed(seed: string): TotpParams {
  const trimmed = seed.trim()
  if (!/^otpauth:/i.test(trimmed)) {
    return { secret: decodeBase32(trimmed), algorithm: 'SHA-1', digits: 6, period: 30 }
  }

  const url = new URL(trimmed)
  if (url.host.toLowerCase() !== 'totp') throw new Error('Only TOTP otpauth URIs are supported')
  const params = url.searchParams

  const secret = params.get('secret')
  if (!secret) throw new Error('otpauth URI has no secret')

  const algorithmName = (params.get('algorithm') ?? 'SHA1').toUpperCase()
  const algorithm = ALGORITHMS[algorithmName]
  if (algorithm === undefined) throw new Error(`Unsupported TOTP algorithm ${algorithmName}`)

  const digits = Number(params.get('digits') ?? '6')
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error('Invalid TOTP digits')

  const period = Number(params.get('period') ?? '30')
  if (!Number.isInteger(period) || period < 1) throw new Error('Invalid TOTP period')

  return { secret: decodeBase32(secret), algorithm, digits, period }
}

export interface TotpCode {
  readonly code: string
  /** Seconds before the code rolls over. */
  readonly remaining: number
}

export async function totp(params: TotpParams, nowMs: number): Promise<TotpCode> {
  const seconds = Math.floor(nowMs / 1000)
  const counter = Math.floor(seconds / params.period)

  const message = new Uint8Array(8)
  new DataView(message.buffer).setBigUint64(0, BigInt(counter))

  const key = await crypto.subtle.importKey(
    'raw',
    params.secret as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: params.algorithm },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))

  const offset = (mac[mac.length - 1] ?? 0) & 0x0f
  const binary = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff
  const code = (binary % 10 ** params.digits).toString().padStart(params.digits, '0')

  return { code, remaining: params.period - (seconds % params.period) }
}
