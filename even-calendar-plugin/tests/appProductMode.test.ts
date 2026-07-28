import { afterEach, describe, expect, it, vi } from 'vitest'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { createApp, type AppDeps } from '../src/app'
import { FakeEvenAppBridge } from './fakes/fakeEvenAppBridge'
import { BridgeProductTokenStore } from '../src/product/tokenStore'
import type { StartPairingOutcome, CheckPairingStatusOutcome, ExchangePairingOutcome } from '../src/product/pairingClient'
import type { RefreshSessionOutcome } from '../src/product/productAuthProvider'
import type { FetchDayEventsOutcome, FetchDayEventsParams } from '../src/dayEventsClient'
import type { AnalyzeAudioOutcome, AnalyzeAudioParams } from '../src/analyzeAudioClient'

function press(): { sysEvent: { eventType: OsEventTypeList } } {
  return { sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } }
}
function doublePress(): { sysEvent: { eventType: OsEventTypeList } } {
  return { sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } }
}
function foregroundEnter(): { sysEvent: { eventType: OsEventTypeList } } {
  return { sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } }
}
function foregroundExit(): { sysEvent: { eventType: OsEventTypeList } } {
  return { sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } }
}

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
  }
}

function stubHealthyFetch(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }))
}

const PRODUCT_BASE_DEPS: Pick<AppDeps, 'baseUrl' | 'productInstallationId' | 'createRequestId'> = {
  baseUrl: 'https://backend.test',
  productInstallationId: '11111111-1111-4111-8111-111111111111',
  createRequestId: () => 'req-fixed-id',
}

/** sessionTokenを明示的に空文字列にすることで製品モードへ分岐させる(config.tsの本番ビルド既定値と同じ)。 */
function productDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return { ...PRODUCT_BASE_DEPS, sessionToken: '', installId: '', ...overrides }
}

function fakeStartPairing(outcome: StartPairingOutcome): { fn: () => Promise<StartPairingOutcome>; calls: number } {
  const state = { calls: 0 }
  const fn = async (): Promise<StartPairingOutcome> => {
    state.calls += 1
    return outcome
  }
  return { fn, calls: state.calls }
}

describe('createApp — Phase 2H dev/product mode selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dev mode (sessionToken set) still starts on the home screen, unaffected by product-mode wiring', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge, { baseUrl: 'https://backend.test', sessionToken: 'dev-token', installId: 'dev-install' })
    await app.start()
    expect(app.getScreen()).toBe('home')
  })

  it('product mode with no stored credential starts on the notConnected screen', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const app = createApp(bridge, productDeps({ tokenStore }))
    await app.start()
    expect(app.getScreen()).toBe('notConnected')
    const initialContent = (bridge.createStartUpCalls[0] as { textObject?: Array<{ content?: string }> })?.textObject?.[0]?.content
    expect(initialContent).toContain('接続が必要です')
  })

  it('product mode with a valid stored credential (unexpired refresh token) starts on the home screen', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    await tokenStore.save({
      refreshToken: 'rt-1',
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
    const app = createApp(bridge, productDeps({ tokenStore }))
    await app.start()
    expect(app.getScreen()).toBe('home')
  })

  it('product mode with an expired refresh token starts on the notConnected screen (does not trust a stale credential)', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    await tokenStore.save({
      refreshToken: 'rt-1',
      refreshTokenExpiresAt: '2020-01-01T00:00:00.000Z',
    })
    const app = createApp(bridge, productDeps({ tokenStore }))
    await app.start()
    expect(app.getScreen()).toBe('notConnected')
  })
})

describe('createApp — Phase 2H pairing flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never calls a Calendar/Gemini client function before pairing completes', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const dayCalls: FetchDayEventsParams[] = []
    const analyzeCalls: AnalyzeAudioParams[] = []
    const app = createApp(
      bridge,
      productDeps({
        tokenStore,
        fetchDayEventsFn: async (p): Promise<FetchDayEventsOutcome> => {
          dayCalls.push(p)
          return { kind: 'failed' }
        },
        analyzeAudioFn: async (p): Promise<AnalyzeAudioOutcome> => {
          analyzeCalls.push(p)
          return { kind: 'failed' }
        },
      }),
    )
    await app.start()
    expect(app.getScreen()).toBe('notConnected')
    bridge.emit(press())
    await flushMicrotasks()
    bridge.emit(doublePress()) // cancel back to notConnected
    await flushMicrotasks()
    expect(dayCalls).toHaveLength(0)
    expect(analyzeCalls).toHaveLength(0)
  })

  it('single press on notConnected starts a pairing and shows the verification URL + code', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const { fn: startPairingFn } = fakeStartPairing({
      kind: 'success',
      pairingId: 'pairing-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'backend.test/connect',
      expiresInSeconds: 600,
      pollIntervalSeconds: 3,
    })
    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()
    expect(app.getScreen()).toBe('pairing')
    expect(bridge.lastTextContent()).toContain('backend.test/connect')
    expect(bridge.lastTextContent()).toContain('ABCD-EFGH')
    expect(app.getPairingContext().state).toBe('waitingApproval')
  })

  it('a second press while already waiting for approval does not start a duplicate pairing (single press on pairing screen is ignored)', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    let startCalls = 0
    const startPairingFn = async (): Promise<StartPairingOutcome> => {
      startCalls += 1
      return {
        kind: 'success',
        pairingId: 'pairing-1',
        userCode: 'ABCD-EFGH',
        verificationUrl: 'backend.test/connect',
        expiresInSeconds: 600,
        pollIntervalSeconds: 3,
      }
    }
    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()
    expect(app.getScreen()).toBe('pairing')
    bridge.emit(press()) // 待機中のpairing画面での単押しは無視される
    await flushMicrotasks()
    expect(startCalls).toBe(1)
  })

  it('double press on the notConnected screen requests system exit confirmation (same as home)', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const app = createApp(bridge, productDeps({ tokenStore }))
    await app.start()
    expect(app.getScreen()).toBe('notConnected')
    bridge.emit(doublePress())
    await flushMicrotasks()
    expect(bridge.shutDownCalls).toEqual([1])
  })

  it('shows a communication-failure error screen when starting the pairing fails', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const { fn: startPairingFn } = fakeStartPairing({ kind: 'network_error' })
    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()
    expect(app.getScreen()).toBe('pairingError')
  })

  it('polls at the server-specified interval, and transitions to success once the pairing is approved and exchanged', async () => {
    vi.useFakeTimers()
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const { fn: startPairingFn } = fakeStartPairing({
      kind: 'success',
      pairingId: 'pairing-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'backend.test/connect',
      expiresInSeconds: 600,
      pollIntervalSeconds: 3,
    })
    let pollCount = 0
    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => {
      pollCount += 1
      return { kind: 'success', status: pollCount < 2 ? 'pending' : 'approved' }
    }
    const exchangePairingFn = async (): Promise<ExchangePairingOutcome> => ({
      kind: 'success',
      accessToken: 'new-access-token',
      accessTokenExpiresInSeconds: 900,
      refreshToken: 'new-refresh-token',
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read'],
    })
    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn, checkPairingStatusFn, exchangePairingFn }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()
    expect(app.getScreen()).toBe('pairing')

    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()
    expect(pollCount).toBe(1)
    expect(app.getScreen()).toBe('pairing') // still pending

    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()
    expect(pollCount).toBe(2)
    expect(app.getScreen()).toBe('pairingSuccess')

    const saved = await tokenStore.load()
    expect(saved?.refreshToken).toBe('new-refresh-token')
    // access tokenはTokenStoreへは一切保存されない(ProductAuthManagerのメモリ上にのみ保持)。
    expect(saved).not.toHaveProperty('accessToken')
    vi.useRealTimers()
  })

  it('shows an expired error screen when the server reports the pairing has expired', async () => {
    vi.useFakeTimers()
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const { fn: startPairingFn } = fakeStartPairing({
      kind: 'success',
      pairingId: 'pairing-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'x',
      expiresInSeconds: 600,
      pollIntervalSeconds: 3,
    })
    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => ({ kind: 'success', status: 'expired' })
    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn, checkPairingStatusFn }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()
    expect(app.getScreen()).toBe('pairingError')
    vi.useRealTimers()
  })

  it('shows a cancelled error screen when the server reports the pairing was cancelled', async () => {
    vi.useFakeTimers()
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const { fn: startPairingFn } = fakeStartPairing({
      kind: 'success',
      pairingId: 'pairing-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'x',
      expiresInSeconds: 600,
      pollIntervalSeconds: 3,
    })
    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => ({ kind: 'success', status: 'cancelled' })
    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn, checkPairingStatusFn }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()
    expect(app.getScreen()).toBe('pairingError')
    vi.useRealTimers()
  })

  it('double press while waiting for approval cancels the pairing and returns to notConnected (no error screen)', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const { fn: startPairingFn } = fakeStartPairing({
      kind: 'success',
      pairingId: 'pairing-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'x',
      expiresInSeconds: 600,
      pollIntervalSeconds: 3,
    })
    let cancelCalled = false
    const cancelPairingFn = async (): Promise<void> => {
      cancelCalled = true
    }
    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn, cancelPairingFn }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()
    bridge.emit(doublePress())
    await flushMicrotasks()
    expect(app.getScreen()).toBe('notConnected')
    expect(cancelCalled).toBe(true)
  })

  it('stops polling while backgrounded and resumes on foreground re-entry', async () => {
    vi.useFakeTimers()
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const { fn: startPairingFn } = fakeStartPairing({
      kind: 'success',
      pairingId: 'pairing-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'x',
      expiresInSeconds: 600,
      pollIntervalSeconds: 3,
    })
    let pollCount = 0
    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => {
      pollCount += 1
      return { kind: 'success', status: 'pending' }
    }
    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn, checkPairingStatusFn }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()

    bridge.emit(foregroundExit())
    await flushMicrotasks()

    // バックグラウンド中はタイマーを進めてもポーリングが起きない
    await vi.advanceTimersByTimeAsync(10_000)
    await flushMicrotasks()
    expect(pollCount).toBe(0)

    bridge.emit(foregroundEnter())
    await flushMicrotasks()
    expect(app.getScreen()).toBe('pairing') // ホームへは戻らない

    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()
    expect(pollCount).toBe(1)
    vi.useRealTimers()
  })
})

describe('createApp — Phase 2H product access-token usage and auth retry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function pairedTokenStore(bridge: FakeEvenAppBridge): Promise<BridgeProductTokenStore> {
    const tokenStore = new BridgeProductTokenStore(bridge)
    await tokenStore.save({
      refreshToken: 'stored-refresh-token',
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
    return tokenStore
  }

  it('obtains an access token via refresh from the persisted refresh token (not a dev token) and uses it for an authenticated call', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = await pairedTokenStore(bridge)
    const dayCalls: FetchDayEventsParams[] = []
    const refreshSessionFn = async (): Promise<RefreshSessionOutcome> => ({
      kind: 'success',
      accessToken: 'obtained-access-token',
      accessTokenExpiresInSeconds: 900,
      refreshToken: 'rotated-refresh-token',
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: [],
    })
    const app = createApp(
      bridge,
      productDeps({
        tokenStore,
        refreshSessionFn,
        fetchDayEventsFn: async (p): Promise<FetchDayEventsOutcome> => {
          dayCalls.push(p)
          return { kind: 'success', result: { schemaVersion: '1', day: 'today', dateLocal: '2026-07-23', timeZone: 'Asia/Tokyo', events: [], truncated: false } }
        },
      }),
    )
    await app.start()
    expect(app.getScreen()).toBe('home')
    bridge.emit({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    bridge.emit({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    await flushMicrotasks()
    bridge.emit(press()) // index 2 = 今日の予定
    await flushMicrotasks()

    expect(dayCalls).toHaveLength(1)
    expect(dayCalls[0]?.sessionToken).toBe('obtained-access-token')
    expect(dayCalls[0]?.installId).toBe(PRODUCT_BASE_DEPS.productInstallationId)
  })

  it('on a 401, refreshes once and retries the original request exactly once, succeeding on retry', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = await pairedTokenStore(bridge)
    let dayCallCount = 0
    const fetchDayEventsFn = async (p: FetchDayEventsParams): Promise<FetchDayEventsOutcome> => {
      dayCallCount += 1
      if (p.sessionToken === 'access-token-1') return { kind: 'auth_failed' }
      return { kind: 'success', result: { schemaVersion: '1', day: 'today', dateLocal: '2026-07-23', timeZone: 'Asia/Tokyo', events: [], truncated: false } }
    }
    let refreshCallCount = 0
    const refreshSessionFn = async (): Promise<RefreshSessionOutcome> => {
      refreshCallCount += 1
      return {
        kind: 'success',
        accessToken: `access-token-${refreshCallCount}`,
        accessTokenExpiresInSeconds: 900,
        refreshToken: `refreshed-refresh-token-${refreshCallCount}`,
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: [],
      }
    }
    const app = createApp(bridge, productDeps({ tokenStore, fetchDayEventsFn, refreshSessionFn }))
    await app.start()
    bridge.emit({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    bridge.emit({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    await flushMicrotasks()
    bridge.emit(press())
    await flushMicrotasks()

    // refreshCallCount=1: コールドスタート時にaccess tokenがメモリに無いための初回refresh(priming)
    // refreshCallCount=2: access-token-1がauth_failedになった後のhandleAuthFailure()によるrefresh
    expect(refreshCallCount).toBe(2)
    expect(dayCallCount).toBe(2) // access-token-1での失敗 + access-token-2での再試行1回のみ
    expect(app.getScreen()).toBe('dayEmpty') // 認証は成功しており、events:[]により空表示画面に到達している
    const saved = await tokenStore.load()
    expect(saved?.refreshToken).toBe('refreshed-refresh-token-2')
  })

  it('on refresh failure, clears the TokenStore and shows the notConnected screen instead of an error screen', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = await pairedTokenStore(bridge)
    let dayCallCount = 0
    const fetchDayEventsFn = async (): Promise<FetchDayEventsOutcome> => {
      dayCallCount += 1
      return { kind: 'auth_failed' }
    }
    const refreshSessionFn = async (): Promise<RefreshSessionOutcome> => ({ kind: 'failed' })
    const app = createApp(bridge, productDeps({ tokenStore, fetchDayEventsFn, refreshSessionFn }))
    await app.start()
    bridge.emit({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    bridge.emit({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    await flushMicrotasks()
    bridge.emit(press())
    await flushMicrotasks()

    expect(app.getScreen()).toBe('notConnected')
    expect(await tokenStore.load()).toBeNull()
    // access tokenがメモリに無いため、refreshに失敗した時点でfetchDayEventsFnへは到達しない。
    expect(dayCallCount).toBe(0)
  })

  it('does not retry more than once even if the retried request also fails with auth_failed (no infinite loop)', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = await pairedTokenStore(bridge)
    let dayCallCount = 0
    const fetchDayEventsFn = async (): Promise<FetchDayEventsOutcome> => {
      dayCallCount += 1
      return { kind: 'auth_failed' }
    }
    let refreshCallCount = 0
    const refreshSessionFn = async (): Promise<RefreshSessionOutcome> => {
      refreshCallCount += 1
      return {
        kind: 'success',
        accessToken: `still-rejected-token-${refreshCallCount}`,
        accessTokenExpiresInSeconds: 900,
        refreshToken: `rt-${refreshCallCount}`,
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: [],
      }
    }
    const app = createApp(bridge, productDeps({ tokenStore, fetchDayEventsFn, refreshSessionFn }))
    await app.start()
    bridge.emit({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    bridge.emit({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    await flushMicrotasks()
    bridge.emit(press())
    await flushMicrotasks()

    expect(refreshCallCount).toBe(2) // コールドスタートpriming + 401後の1回だけの再refresh
    expect(dayCallCount).toBe(2) // 元のリクエスト + 1回だけの再試行(2回目以降のretryはしない)
    expect(app.getScreen()).toBe('dayError')
  })
})

describe('createApp — Phase 2H privacy: no sensitive console logs', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('never logs the raw access token, refresh token, or userCode during the pairing flow', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const { fn: startPairingFn } = fakeStartPairing({
      kind: 'success',
      pairingId: 'pairing-1',
      userCode: 'SECRET-CODE',
      verificationUrl: 'backend.test/connect',
      expiresInSeconds: 600,
      pollIntervalSeconds: 3,
    })
    const exchangePairingFn = async (): Promise<ExchangePairingOutcome> => ({
      kind: 'success',
      accessToken: 'SECRET-ACCESS-TOKEN',
      accessTokenExpiresInSeconds: 900,
      refreshToken: 'SECRET-REFRESH-TOKEN',
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: [],
    })
    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => ({ kind: 'success', status: 'approved' })
    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn, checkPairingStatusFn, exchangePairingFn, pairingPollMaxDurationMs: 60_000 }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()

    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(allLogText).not.toContain('SECRET-CODE')
    expect(allLogText).not.toContain('SECRET-ACCESS-TOKEN')
    expect(allLogText).not.toContain('SECRET-REFRESH-TOKEN')
    logSpy.mockRestore()
  })
})
