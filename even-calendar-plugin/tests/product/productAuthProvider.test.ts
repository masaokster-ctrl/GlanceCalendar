import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductAuthManager, refreshProductSession, type RefreshSessionOutcome } from '../../src/product/productAuthProvider'
import { BridgeProductTokenStore, type PersistedProductCredential } from '../../src/product/tokenStore'

const INSTALLATION_ID = '11111111-1111-4111-8111-111111111111'

const CREDENTIAL: PersistedProductCredential = {
  refreshToken: 'old-refresh-token',
  refreshTokenExpiresAt: '2026-08-22T05:00:00.000Z',
}

class FakeStorage {
  private map = new Map<string, string>()
  async setLocalStorage(key: string, value: string): Promise<boolean> {
    this.map.set(key, value)
    return true
  }
  async getLocalStorage(key: string): Promise<string> {
    return this.map.get(key) ?? ''
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('refreshProductSession', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns success with the rotated token fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          accessToken: 'new-at',
          accessTokenExpiresInSeconds: 900,
          refreshToken: 'new-rt',
          refreshTokenExpiresAt: '2026-08-22T05:00:00.000Z',
          scopes: ['calendar:read'],
        }),
      ),
    )
    const outcome = await refreshProductSession({ baseUrl: 'https://backend.test', installationId: 'i-1', refreshToken: 'rt' })
    expect(outcome.kind).toBe('success')
  })

  it('returns failed on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    const outcome = await refreshProductSession({ baseUrl: 'https://backend.test', installationId: 'i-1', refreshToken: 'rt' })
    expect(outcome.kind).toBe('failed')
  })

  it('returns failed (not a throw) on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    const outcome = await refreshProductSession({ baseUrl: 'https://backend.test', installationId: 'i-1', refreshToken: 'rt' })
    expect(outcome.kind).toBe('failed')
  })
})

describe('ProductAuthManager.getAccessToken', () => {
  it('triggers a refresh on first call (no in-memory access token yet) and returns the new access token', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    await tokenStore.save(CREDENTIAL)
    const refreshFn = vi.fn().mockResolvedValue({
      kind: 'success',
      accessToken: 'new-access-token',
      accessTokenExpiresInSeconds: 900,
      refreshToken: 'new-refresh-token',
      refreshTokenExpiresAt: '2026-08-23T05:00:00.000Z',
      scopes: ['calendar:read'],
    } satisfies RefreshSessionOutcome)
    const manager = new ProductAuthManager({
      tokenStore,
      baseUrl: 'https://backend.test',
      installationId: INSTALLATION_ID,
      refreshFn,
      now: () => new Date('2026-07-23T05:00:00.000Z'),
    })

    const token = await manager.getAccessToken()
    expect(token).toBe('new-access-token')
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('persists only the rotated refresh token (never the access token) to the TokenStore', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    await tokenStore.save(CREDENTIAL)
    const refreshFn = vi.fn().mockResolvedValue({
      kind: 'success',
      accessToken: 'new-access-token',
      accessTokenExpiresInSeconds: 900,
      refreshToken: 'new-refresh-token',
      refreshTokenExpiresAt: '2026-08-23T05:00:00.000Z',
      scopes: [],
    } satisfies RefreshSessionOutcome)
    const manager = new ProductAuthManager({ tokenStore, baseUrl: 'https://backend.test', installationId: INSTALLATION_ID, refreshFn })

    await manager.getAccessToken()

    const saved = await tokenStore.load()
    expect(saved?.refreshToken).toBe('new-refresh-token')
    expect(saved?.refreshTokenExpiresAt).toBe('2026-08-23T05:00:00.000Z')
    expect(Object.keys(saved ?? {})).toEqual(['refreshToken', 'refreshTokenExpiresAt'])
  })

  it('returns the cached in-memory access token on a second call without refreshing again', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    await tokenStore.save(CREDENTIAL)
    const refreshFn = vi.fn().mockResolvedValue({
      kind: 'success',
      accessToken: 'cached-token',
      accessTokenExpiresInSeconds: 900,
      refreshToken: 'new-refresh-token',
      refreshTokenExpiresAt: '2026-08-23T05:00:00.000Z',
      scopes: [],
    } satisfies RefreshSessionOutcome)
    const manager = new ProductAuthManager({
      tokenStore,
      baseUrl: 'https://backend.test',
      installationId: INSTALLATION_ID,
      refreshFn,
      now: () => new Date('2026-07-23T05:00:00.000Z'),
    })

    const first = await manager.getAccessToken()
    const second = await manager.getAccessToken()
    expect(first).toBe('cached-token')
    expect(second).toBe('cached-token')
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('re-refreshes once the cached access token has expired', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    await tokenStore.save(CREDENTIAL)
    let currentTime = new Date('2026-07-23T05:00:00.000Z')
    const refreshFn = vi.fn().mockResolvedValue({
      kind: 'success',
      accessToken: 'short-lived-token',
      accessTokenExpiresInSeconds: 60,
      refreshToken: 'new-refresh-token',
      refreshTokenExpiresAt: '2026-08-23T05:00:00.000Z',
      scopes: [],
    } satisfies RefreshSessionOutcome)
    const manager = new ProductAuthManager({
      tokenStore,
      baseUrl: 'https://backend.test',
      installationId: INSTALLATION_ID,
      refreshFn,
      now: () => currentTime,
    })

    await manager.getAccessToken()
    currentTime = new Date(currentTime.getTime() + 61_000)
    await manager.getAccessToken()
    expect(refreshFn).toHaveBeenCalledTimes(2)
  })

  it('returns null and calls onDisconnected when there is no stored refresh token', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    const refreshFn = vi.fn()
    const onDisconnected = vi.fn()
    const manager = new ProductAuthManager({ tokenStore, baseUrl: 'https://backend.test', installationId: INSTALLATION_ID, refreshFn, onDisconnected })

    const token = await manager.getAccessToken()
    expect(token).toBeNull()
    expect(refreshFn).not.toHaveBeenCalled()
    expect(onDisconnected).toHaveBeenCalledTimes(1)
  })
})

describe('ProductAuthManager.primeAccessToken', () => {
  it('makes an access token available in memory without touching the TokenStore', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    const refreshFn = vi.fn()
    const manager = new ProductAuthManager({
      tokenStore,
      baseUrl: 'https://backend.test',
      installationId: INSTALLATION_ID,
      refreshFn,
      now: () => new Date('2026-07-23T05:00:00.000Z'),
    })

    manager.primeAccessToken('primed-token', 900)
    const token = await manager.getAccessToken()
    expect(token).toBe('primed-token')
    expect(refreshFn).not.toHaveBeenCalled()
    expect(await tokenStore.load()).toBeNull()
  })
})

describe('ProductAuthManager.handleAuthFailure', () => {
  it('discards the cached access token and refreshes, saving only the new refresh token', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    await tokenStore.save(CREDENTIAL)
    const refreshFn = vi.fn().mockResolvedValue({
      kind: 'success',
      accessToken: 'new-access-token',
      accessTokenExpiresInSeconds: 900,
      refreshToken: 'new-refresh-token',
      refreshTokenExpiresAt: '2026-08-23T05:00:00.000Z',
      scopes: ['calendar:read'],
    } satisfies RefreshSessionOutcome)
    const manager = new ProductAuthManager({ tokenStore, baseUrl: 'https://backend.test', installationId: INSTALLATION_ID, refreshFn })
    manager.primeAccessToken('rejected-token', 900)

    const ok = await manager.handleAuthFailure()
    expect(ok).toBe(true)
    expect(await manager.getAccessToken()).toBe('new-access-token')
    expect(refreshFn).toHaveBeenCalledTimes(1) // handleAuthFailure内の1回のみ、getAccessTokenはキャッシュを再利用

    const saved = await tokenStore.load()
    expect(saved?.refreshToken).toBe('new-refresh-token')
  })

  it('clears the TokenStore and calls onDisconnected when refresh fails', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    await tokenStore.save(CREDENTIAL)
    const refreshFn = vi.fn().mockResolvedValue({ kind: 'failed' } satisfies RefreshSessionOutcome)
    const onDisconnected = vi.fn()
    const manager = new ProductAuthManager({ tokenStore, baseUrl: 'https://backend.test', installationId: INSTALLATION_ID, refreshFn, onDisconnected })

    const ok = await manager.handleAuthFailure()
    expect(ok).toBe(false)
    expect(await tokenStore.load()).toBeNull()
    expect(onDisconnected).toHaveBeenCalledTimes(1)
  })

  it('calls onDisconnected immediately (without attempting refresh) when there is no stored credential', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    const refreshFn = vi.fn()
    const onDisconnected = vi.fn()
    const manager = new ProductAuthManager({ tokenStore, baseUrl: 'https://backend.test', installationId: INSTALLATION_ID, refreshFn, onDisconnected })

    const ok = await manager.handleAuthFailure()
    expect(ok).toBe(false)
    expect(refreshFn).not.toHaveBeenCalled()
    expect(onDisconnected).toHaveBeenCalledTimes(1)
  })

  it('de-duplicates concurrent calls into a single network refresh (single-flight)', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    await tokenStore.save(CREDENTIAL)
    let resolveRefresh: (value: RefreshSessionOutcome) => void = () => {}
    const refreshFn = vi.fn().mockImplementation(
      () =>
        new Promise<RefreshSessionOutcome>((resolve) => {
          resolveRefresh = resolve
        }),
    )
    const manager = new ProductAuthManager({ tokenStore, baseUrl: 'https://backend.test', installationId: INSTALLATION_ID, refreshFn })

    const first = manager.handleAuthFailure()
    const second = manager.handleAuthFailure()
    await Promise.resolve()
    await Promise.resolve()
    expect(refreshFn).toHaveBeenCalledTimes(1)

    resolveRefresh({
      kind: 'success',
      accessToken: 'new-at',
      accessTokenExpiresInSeconds: 900,
      refreshToken: 'new-rt',
      refreshTokenExpiresAt: '2026-08-23T05:00:00.000Z',
      scopes: [],
    })

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toBe(true)
    expect(secondResult).toBe(true)
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh refresh attempt after a prior in-flight refresh has settled', async () => {
    const tokenStore = new BridgeProductTokenStore(new FakeStorage())
    await tokenStore.save(CREDENTIAL)
    const refreshFn = vi.fn().mockResolvedValue({
      kind: 'success',
      accessToken: 'at-1',
      accessTokenExpiresInSeconds: 900,
      refreshToken: 'rt-1',
      refreshTokenExpiresAt: '2026-08-23T05:00:00.000Z',
      scopes: [],
    } satisfies RefreshSessionOutcome)
    const manager = new ProductAuthManager({ tokenStore, baseUrl: 'https://backend.test', installationId: INSTALLATION_ID, refreshFn })

    await manager.handleAuthFailure()
    await manager.handleAuthFailure()
    expect(refreshFn).toHaveBeenCalledTimes(2)
  })
})
