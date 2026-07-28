import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelPairing, checkPairingStatus, exchangePairing, startPairing } from '../../src/product/pairingClient'

const BASE_URL = 'https://backend.test'
const INSTALL_ID = '11111111-1111-4111-8111-111111111111'
const PAIRING_ID = 'pairing-1'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('startPairing', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns success with pairingId/userCode/verificationUrl/expiresInSeconds/pollIntervalSeconds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(201, {
          pairingId: PAIRING_ID,
          userCode: 'ABCD-EFGH',
          verificationUrl: 'https://backend.test/connect',
          expiresInSeconds: 600,
          pollIntervalSeconds: 3,
        }),
      ),
    )
    const outcome = await startPairing({ baseUrl: BASE_URL, installationId: INSTALL_ID })
    expect(outcome).toEqual({
      kind: 'success',
      pairingId: PAIRING_ID,
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://backend.test/connect',
      expiresInSeconds: 600,
      pollIntervalSeconds: 3,
    })
  })

  it('sends installationId in the JSON body with no Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, { pairingId: PAIRING_ID, userCode: 'ABCD-EFGH', verificationUrl: 'x', expiresInSeconds: 600, pollIntervalSeconds: 3 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await startPairing({ baseUrl: BASE_URL, installationId: INSTALL_ID, appVersion: '1.0.0', sdkVersion: '0.0.12' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE_URL}/product/pairings`)
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ installationId: INSTALL_ID, appVersion: '1.0.0', sdkVersion: '0.0.12' })
  })

  it('maps 429 to rate_limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429 })))
    expect((await startPairing({ baseUrl: BASE_URL, installationId: INSTALL_ID })).kind).toBe('rate_limited')
  })

  it('maps a network throw to network_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    expect((await startPairing({ baseUrl: BASE_URL, installationId: INSTALL_ID })).kind).toBe('network_error')
  })

  it('returns aborted when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn())
    expect((await startPairing({ baseUrl: BASE_URL, installationId: INSTALL_ID, signal: controller.signal })).kind).toBe('aborted')
  })
})

describe('checkPairingStatus', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns success with the status enum', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { status: 'approved' })))
    const outcome = await checkPairingStatus({ baseUrl: BASE_URL, pairingId: PAIRING_ID, installationId: INSTALL_ID })
    expect(outcome).toEqual({ kind: 'success', status: 'approved' })
  })

  it('sends X-Installation-Id header on a GET request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'pending' }))
    vi.stubGlobal('fetch', fetchMock)
    await checkPairingStatus({ baseUrl: BASE_URL, pairingId: PAIRING_ID, installationId: INSTALL_ID })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE_URL}/product/pairings/${PAIRING_ID}/status`)
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['X-Installation-Id']).toBe(INSTALL_ID)
  })

  it('returns failed for an unrecognized status value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { status: 'not-a-real-status' })))
    expect((await checkPairingStatus({ baseUrl: BASE_URL, pairingId: PAIRING_ID, installationId: INSTALL_ID })).kind).toBe('failed')
  })
})

describe('cancelPairing', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts installationId and does not throw even on failure (best-effort)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(cancelPairing({ baseUrl: BASE_URL, pairingId: PAIRING_ID, installationId: INSTALL_ID })).resolves.toBeUndefined()
  })
})

describe('exchangePairing', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns success with the device session fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          accessToken: 'at-1',
          accessTokenExpiresInSeconds: 900,
          refreshToken: 'rt-1',
          refreshTokenExpiresAt: '2026-08-22T05:00:00.000Z',
          scopes: ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read'],
        }),
      ),
    )
    const outcome = await exchangePairing({ baseUrl: BASE_URL, pairingId: PAIRING_ID, installationId: INSTALL_ID })
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.accessToken).toBe('at-1')
      expect(outcome.refreshToken).toBe('rt-1')
    }
  })

  it('maps 409 to not_ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 409 })))
    expect((await exchangePairing({ baseUrl: BASE_URL, pairingId: PAIRING_ID, installationId: INSTALL_ID })).kind).toBe('not_ready')
  })

  it('maps 400 to not_ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 400 })))
    expect((await exchangePairing({ baseUrl: BASE_URL, pairingId: PAIRING_ID, installationId: INSTALL_ID })).kind).toBe('not_ready')
  })
})
