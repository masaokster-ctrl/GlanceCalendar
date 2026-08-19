import { describe, expect, it, vi, afterEach } from 'vitest'
import { generateCredentialCandidate, generateCredentialCandidatePair } from '../../src/product/credentialCandidate'

const HEX64 = /^[0-9a-f]{64}$/

describe('generateCredentialCandidate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns a 64-character lowercase hex string', () => {
    const candidate = generateCredentialCandidate()
    expect(candidate).toMatch(HEX64)
  })

  it('returns a different value on each call (uses real randomness, not a fixed value)', () => {
    const a = generateCredentialCandidate()
    const b = generateCredentialCandidate()
    expect(a).not.toBe(b)
  })

  it('calls crypto.getRandomValues with a 32-byte buffer', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues')
    generateCredentialCandidate()
    expect(spy).toHaveBeenCalledTimes(1)
    const arg = spy.mock.calls[0]?.[0] as Uint8Array
    expect(arg).toBeInstanceOf(Uint8Array)
    expect(arg.length).toBe(32)
  })

  it('fails closed (throws) when crypto.getRandomValues is unavailable, instead of falling back to Math.random()', () => {
    const originalCrypto = globalThis.crypto
    // @ts-expect-error -- 意図的にcrypto自体を消して未対応環境を再現する
    delete globalThis.crypto
    try {
      expect(() => generateCredentialCandidate()).toThrow('secure random number generator unavailable')
    } finally {
      globalThis.crypto = originalCrypto
    }
  })

  it('fails closed (throws) when crypto exists but getRandomValues does not', () => {
    const originalCrypto = globalThis.crypto
    // @ts-expect-error -- getRandomValuesだけ欠けた不完全な実装を再現する
    globalThis.crypto = {}
    try {
      expect(() => generateCredentialCandidate()).toThrow('secure random number generator unavailable')
    } finally {
      globalThis.crypto = originalCrypto
    }
  })
})

describe('generateCredentialCandidatePair', () => {
  it('returns two distinct 64-character hex candidates (accessToken, refreshToken)', () => {
    const pair = generateCredentialCandidatePair()
    expect(pair.accessToken).toMatch(HEX64)
    expect(pair.refreshToken).toMatch(HEX64)
    expect(pair.accessToken).not.toBe(pair.refreshToken)
  })
})
