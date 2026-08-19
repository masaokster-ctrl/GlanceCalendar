import { afterEach, describe, expect, it, vi } from 'vitest'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { createApp, type AppDeps } from '../src/app'
import { FakeEvenAppBridge } from './fakes/fakeEvenAppBridge'
import { BridgeProductTokenStore } from '../src/product/tokenStore'
import { BridgePairingResumeStore, type PersistedPairingResume } from '../src/product/pairingResumeStore'
import type { StartPairingOutcome, CheckPairingStatusOutcome, ExchangePairingOutcome, ExchangePairingParams } from '../src/product/pairingClient'

function press(): { sysEvent: { eventType: OsEventTypeList } } {
  return { sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } }
}
function foregroundEnter(): { sysEvent: { eventType: OsEventTypeList } } {
  return { sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } }
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

function productDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return { ...PRODUCT_BASE_DEPS, sessionToken: '', installId: '', ...overrides }
}

const RESUME_CANDIDATE = { accessToken: 'a'.repeat(64), refreshToken: 'b'.repeat(64) }

function persistedResume(overrides: Partial<PersistedPairingResume> = {}): PersistedPairingResume {
  return {
    pairingId: 'pairing-1',
    userCode: 'ABCD-EFGH',
    pollIntervalSeconds: 3,
    expiresAt: Date.now() + 600_000,
    exchangeCandidate: null,
    ...overrides,
  }
}

describe('createApp — BOOT-time pairing resume', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resumes a still-pending persisted pairing: shows the pairing screen with the persisted code and resumes polling', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const pairingResumeStore = new BridgePairingResumeStore(bridge)
    await pairingResumeStore.save(persistedResume())

    let statusCalls = 0
    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => {
      statusCalls += 1
      return { kind: 'success', status: 'pending' }
    }
    const app = createApp(bridge, productDeps({ tokenStore, checkPairingStatusFn }))
    await app.start()
    await flushMicrotasks()

    expect(app.getScreen()).toBe('pairing')
    // statusがpendingのまま変化しないため、初回のcreateStartUpPageContainer以降は再描画が発生しない
    // (textContainerUpgradeは呼ばれない)。最初のcontainer contentを直接確認する。
    const initialContent = (bridge.createStartUpCalls[0] as { textObject?: Array<{ content?: string }> })?.textObject?.[0]?.content
    expect(initialContent).toContain('ABCD-EFGH')
    expect(app.getPairingContext().state).toBe('waitingApproval')
    expect(statusCalls).toBe(1) // BOOT時に即座に1回問い合わせる(setTimeoutを待たない)
  })

  it('resumes a persisted pairing that the server already approved: generates a fresh candidate, exchanges, and succeeds', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const pairingResumeStore = new BridgePairingResumeStore(bridge)
    await pairingResumeStore.save(persistedResume())

    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => ({ kind: 'success', status: 'approved' })
    const exchangePairingFn = async (params: ExchangePairingParams): Promise<ExchangePairingOutcome> => ({
      kind: 'success',
      accessToken: params.accessToken,
      accessTokenExpiresInSeconds: 900,
      refreshToken: params.refreshToken,
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: [],
    })
    const app = createApp(
      bridge,
      productDeps({
        tokenStore,
        checkPairingStatusFn,
        exchangePairingFn,
        generateCredentialCandidatePairFn: () => RESUME_CANDIDATE,
      }),
    )
    await app.start()
    await flushMicrotasks()

    expect(app.getScreen()).toBe('pairingSuccess')
    const saved = await tokenStore.load()
    expect(saved?.refreshToken).toBe(RESUME_CANDIDATE.refreshToken)
    expect(await pairingResumeStore.load()).toBeNull() // 成功後はresumeを削除する
  })

  it('resumes a persisted pairing that the server already exchanged (idempotent replay): reuses the same persisted candidate and succeeds', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const pairingResumeStore = new BridgePairingResumeStore(bridge)
    await pairingResumeStore.save(persistedResume({ exchangeCandidate: RESUME_CANDIDATE }))

    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => ({ kind: 'success', status: 'exchanged' })
    const usedCandidates: ExchangePairingParams[] = []
    const exchangePairingFn = async (params: ExchangePairingParams): Promise<ExchangePairingOutcome> => {
      usedCandidates.push(params)
      return {
        kind: 'success',
        accessToken: params.accessToken,
        accessTokenExpiresInSeconds: 900,
        refreshToken: params.refreshToken,
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: [],
      }
    }
    const app = createApp(bridge, productDeps({ tokenStore, checkPairingStatusFn, exchangePairingFn }))
    await app.start()
    await flushMicrotasks()

    expect(app.getScreen()).toBe('pairingSuccess')
    // 新しい候補を生成し直さず、永続化されていた候補をそのまま再送している
    expect(usedCandidates).toHaveLength(1)
    expect(usedCandidates[0]?.accessToken).toBe(RESUME_CANDIDATE.accessToken)
    expect(usedCandidates[0]?.refreshToken).toBe(RESUME_CANDIDATE.refreshToken)
  })

  it('resumes a persisted pairing the server reports expired: shows pairingError and clears the resume record', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const pairingResumeStore = new BridgePairingResumeStore(bridge)
    await pairingResumeStore.save(persistedResume())

    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => ({ kind: 'success', status: 'expired' })
    const app = createApp(bridge, productDeps({ tokenStore, checkPairingStatusFn }))
    await app.start()
    await flushMicrotasks()

    expect(app.getScreen()).toBe('pairingError')
    expect(await pairingResumeStore.load()).toBeNull()
  })

  it('a locally-expired persisted pairing (expiresAt already in the past) is discarded without any network status check', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const pairingResumeStore = new BridgePairingResumeStore(bridge)
    await pairingResumeStore.save(persistedResume({ expiresAt: Date.now() - 1000 }))

    let statusCalls = 0
    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => {
      statusCalls += 1
      return { kind: 'success', status: 'pending' }
    }
    const app = createApp(bridge, productDeps({ tokenStore, checkPairingStatusFn }))
    await app.start()
    await flushMicrotasks()

    expect(app.getScreen()).toBe('notConnected') // pairing画面すら経由しない
    expect(statusCalls).toBe(0)
    expect(await pairingResumeStore.load()).toBeNull()
  })

  it('when the resume candidate matches the currently-stored valid refresh token, discards the stale resume record and goes straight home', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    await tokenStore.save({ refreshToken: RESUME_CANDIDATE.refreshToken, refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    const pairingResumeStore = new BridgePairingResumeStore(bridge)
    await pairingResumeStore.save(persistedResume({ exchangeCandidate: RESUME_CANDIDATE }))

    let exchangeCalls = 0
    const exchangePairingFn = async (): Promise<ExchangePairingOutcome> => {
      exchangeCalls += 1
      return { kind: 'failed' }
    }
    const app = createApp(bridge, productDeps({ tokenStore, exchangePairingFn }))
    await app.start()
    await flushMicrotasks()

    expect(app.getScreen()).toBe('home')
    expect(exchangeCalls).toBe(0) // exchangeは呼ばれない(既に確定済みと判断)
    expect(await pairingResumeStore.load()).toBeNull()
    expect((await tokenStore.load())?.refreshToken).toBe(RESUME_CANDIDATE.refreshToken)
  })

  it('when the resume candidate does NOT match the currently-stored valid refresh token (rotation happened since), discards the stale resume and keeps the current (rotated) credential intact', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const rotatedRefreshToken = 'rotated-' + 'c'.repeat(56)
    await tokenStore.save({ refreshToken: rotatedRefreshToken, refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    const pairingResumeStore = new BridgePairingResumeStore(bridge)
    await pairingResumeStore.save(persistedResume({ exchangeCandidate: RESUME_CANDIDATE })) // 古い候補(rotation前)

    let exchangeCalls = 0
    const exchangePairingFn = async (): Promise<ExchangePairingOutcome> => {
      exchangeCalls += 1
      return { kind: 'success', accessToken: RESUME_CANDIDATE.accessToken, accessTokenExpiresInSeconds: 900, refreshToken: RESUME_CANDIDATE.refreshToken, refreshTokenExpiresAt: new Date().toISOString(), scopes: [] }
    }
    const app = createApp(bridge, productDeps({ tokenStore, exchangePairingFn }))
    await app.start()
    await flushMicrotasks()

    expect(app.getScreen()).toBe('home')
    expect(exchangeCalls).toBe(0) // 古い候補で再exchangeを試みない
    expect(await pairingResumeStore.load()).toBeNull()
    // 現在有効なrefresh tokenが、古いresume候補によって上書きされていないことを確認する
    expect((await tokenStore.load())?.refreshToken).toBe(rotatedRefreshToken)
  })
})

describe('createApp — foreground guard covers starting/exchanging (not only waitingApproval)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a foreground re-entry while pairing is in the "starting" sub-state does not force-navigate to home', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)

    let resolveStart!: (outcome: StartPairingOutcome) => void
    const startPairingFn = (): Promise<StartPairingOutcome> => new Promise((resolve) => { resolveStart = resolve })

    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn }))
    await app.start()
    bridge.emit(press()) // startPairingFlow()開始、startPairingFnがまだ解決していない(state='starting')
    await flushMicrotasks()
    expect(app.getPairingContext().state).toBe('starting')
    expect(app.getScreen()).toBe('pairing')

    bridge.emit(foregroundEnter())
    await flushMicrotasks()
    // starting中はhomeへ強制的に戻らない(進行中のstartPairingFlow()が自己解決するのを妨げない)
    expect(app.getScreen()).toBe('pairing')

    resolveStart({ kind: 'success', pairingId: 'pairing-1', userCode: 'ABCD-EFGH', verificationUrl: 'x', expiresInSeconds: 600, pollIntervalSeconds: 3 })
    await flushMicrotasks()
    expect(app.getScreen()).toBe('pairing')
    expect(app.getPairingContext().state).toBe('waitingApproval')
  })

  it('a foreground re-entry while pairing is in the "exchanging" sub-state does not force-navigate to home', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const { fn: startPairingFn } = (() => {
      const fn = async (): Promise<StartPairingOutcome> => ({
        kind: 'success', pairingId: 'pairing-1', userCode: 'ABCD-EFGH', verificationUrl: 'x', expiresInSeconds: 600, pollIntervalSeconds: 3,
      })
      return { fn }
    })()
    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => ({ kind: 'success', status: 'approved' })

    let resolveExchange!: (outcome: ExchangePairingOutcome) => void
    const exchangePairingFn = (): Promise<ExchangePairingOutcome> => new Promise((resolve) => { resolveExchange = resolve })

    vi.useFakeTimers()
    const app = createApp(bridge, productDeps({ tokenStore, startPairingFn, checkPairingStatusFn, exchangePairingFn }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()
    expect(app.getPairingContext().state).toBe('exchanging')
    expect(app.getScreen()).toBe('pairing')

    bridge.emit(foregroundEnter())
    await flushMicrotasks()
    expect(app.getScreen()).toBe('pairing') // exchanging中もhomeへ強制的に戻らない

    resolveExchange({ kind: 'success', accessToken: 'a'.repeat(64), accessTokenExpiresInSeconds: 900, refreshToken: 'b'.repeat(64), refreshTokenExpiresAt: new Date().toISOString(), scopes: [] })
    await flushMicrotasks()
    expect(app.getScreen()).toBe('pairingSuccess')
    vi.useRealTimers()
  })
})

describe('createApp — exchange candidate persistence ordering', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists the exchange candidate to pairingResumeStore before calling exchangePairingFn (so a crash before the HTTP response can still recover)', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const tokenStore = new BridgeProductTokenStore(bridge)
    const pairingResumeStore = new BridgePairingResumeStore(bridge)
    const { fn: startPairingFn } = (() => {
      const fn = async (): Promise<StartPairingOutcome> => ({
        kind: 'success', pairingId: 'pairing-1', userCode: 'ABCD-EFGH', verificationUrl: 'x', expiresInSeconds: 600, pollIntervalSeconds: 3,
      })
      return { fn }
    })()
    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => ({ kind: 'success', status: 'approved' })

    let candidateInStoreAtExchangeTime: PersistedPairingResume | null = null
    const exchangePairingFn = async (): Promise<ExchangePairingOutcome> => {
      candidateInStoreAtExchangeTime = await pairingResumeStore.load()
      return { kind: 'network_error' } // レスポンス消失を模す(この後どうなるかはこのテストの範囲外)
    }

    vi.useFakeTimers()
    const app = createApp(bridge, productDeps({ tokenStore, pairingResumeStore, startPairingFn, checkPairingStatusFn, exchangePairingFn }))
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()

    expect(candidateInStoreAtExchangeTime).not.toBeNull()
    expect(candidateInStoreAtExchangeTime?.exchangeCandidate).not.toBeNull()
    vi.useRealTimers()
  })

  it('does not clear pairingResumeStore if tokenStore.save() fails after a successful exchange response', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const pairingResumeStore = new BridgePairingResumeStore(bridge)
    const failingTokenStore = {
      load: async () => null,
      save: async () => {
        throw new Error('save failed')
      },
      clear: async () => {},
    }
    const { fn: startPairingFn } = (() => {
      const fn = async (): Promise<StartPairingOutcome> => ({
        kind: 'success', pairingId: 'pairing-1', userCode: 'ABCD-EFGH', verificationUrl: 'x', expiresInSeconds: 600, pollIntervalSeconds: 3,
      })
      return { fn }
    })()
    const checkPairingStatusFn = async (): Promise<CheckPairingStatusOutcome> => ({ kind: 'success', status: 'approved' })
    const exchangePairingFn = async (params: ExchangePairingParams): Promise<ExchangePairingOutcome> => ({
      kind: 'success',
      accessToken: params.accessToken,
      accessTokenExpiresInSeconds: 900,
      refreshToken: params.refreshToken,
      refreshTokenExpiresAt: new Date().toISOString(),
      scopes: [],
    })

    vi.useFakeTimers()
    const app = createApp(
      bridge,
      productDeps({ tokenStore: failingTokenStore, pairingResumeStore, startPairingFn, checkPairingStatusFn, exchangePairingFn }),
    )
    await app.start()
    bridge.emit(press())
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(3000)
    await flushMicrotasks()

    expect(app.getScreen()).toBe('pairingError')
    // tokenStore.save()が失敗したため、pairingResumeStoreは削除されず、次回起動時に再試行できる状態を保つ
    const stillPersisted = await pairingResumeStore.load()
    expect(stillPersisted).not.toBeNull()
    expect(stillPersisted?.exchangeCandidate).not.toBeNull()
    vi.useRealTimers()
  })
})
