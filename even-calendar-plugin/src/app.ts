import {
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  AudioInputSource,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { recordingReducer, initialRecordingContext, type RecordingContext } from './recordingState'
import { analysisReducer, initialAnalysisContext, type AnalysisContext } from './analysisState'
import { registrationReducer, initialRegistrationContext, type RegistrationContext } from './registrationState'
import { PcmBuffer, MAX_RECORDING_SECONDS, MIN_RECORDING_SECONDS } from './recorder'
import { encodeWav } from './wav'
import * as screens from './screens'
import { checkBackendHealth } from './backendHealth'
import { saveBackendAvailable, loadLocale } from './storage'
import { detectLocale, setActiveLocale, getActiveLocale, type Locale } from './i18n/locale'
import { logSafe } from './safeLog'
import { errorMessage, type ErrorCode } from './errors'
import { BACKEND_BASE_URL, PLUGIN_SESSION_TOKEN, PLUGIN_INSTALL_ID } from './config'
import { analyzeAudio, type AnalyzeAudioParams, type AnalyzeAudioOutcome } from './analyzeAudioClient'
import {
  registerCalendarEvent,
  pollForCompletion,
  type RegisterEventParams,
  type RegisterEventOutcome,
  type PollForCompletionParams,
  type CheckStatusOutcome,
} from './calendarRegistrationClient'
import {
  nowLocalIsoTokyo,
  parseLocalDateTime,
  validateEventCandidateTiming,
  validateFollowupCandidateTiming,
  type EventCandidateResult,
  type FollowupResult,
} from './eventCandidate'
import {
  analyzeFollowupAudio,
  cancelConversation,
  type AnalyzeFollowupParams,
  type AnalyzeFollowupOutcome,
  type CancelConversationParams,
} from './followupAudioClient'
import { fetchDayEvents, type FetchDayEventsParams, type FetchDayEventsOutcome } from './dayEventsClient'
import { sortEventsForDisplay, formatDayEventLine, type DayKind } from './dayEvents'
import { dayEventsReducer, initialDayEventsContext, DAY_EVENTS_PER_PAGE, type DayEventsContext } from './dayEventsState'
import { fetchUpcomingEvents, type FetchUpcomingEventsParams, type FetchUpcomingEventsOutcome } from './upcomingEventsClient'
import { formatUpcomingEventLine } from './upcomingEvents'
import { upcomingEventsReducer, initialUpcomingEventsContext, UPCOMING_EVENTS_PER_PAGE, type UpcomingEventsContext } from './upcomingEventsState'
import { buildEventDetailLines, formatEventDetailWhen } from './eventDetail'
import {
  fetchEventDetail,
  updateCalendarEventDetail,
  deleteCalendarEventDetail,
  type FetchEventDetailParams,
  type FetchEventDetailOutcome,
  type UpdateEventParams,
  type UpdateEventOutcome,
  type DeleteEventParams,
  type DeleteEventOutcome,
} from './eventDetailClient'
import {
  eventDetailReducer,
  initialEventDetailContext,
  eventDetailPageCount,
  EVENT_DETAIL_LINES_PER_PAGE,
  type EventDetailContext,
} from './eventDetailState'
import { eventMutationReducer, initialEventMutationContext, type EventMutationContext } from './eventMutationState'
import { editAnalysisReducer, initialEditAnalysisContext, type EditAnalysisContext } from './editAnalysisState'
import { validateEditInstructionTiming, computeEditDiff, fieldsForDiff, type EditInstructionFields } from './editInstruction'
import { analyzeEditAudio, type AnalyzeEditAudioParams, type AnalyzeEditAudioOutcome } from './editAudioClient'
import { pairingReducer, initialPairingContext, type PairingContext } from './product/pairingState'
import {
  startPairing,
  checkPairingStatus,
  cancelPairing,
  exchangePairing,
  type StartPairingParams,
  type StartPairingOutcome,
  type CheckPairingStatusParams,
  type CheckPairingStatusOutcome,
  type CancelPairingParams,
  type ExchangePairingParams,
  type ExchangePairingOutcome,
} from './product/pairingClient'
import { ProductAuthManager, type RefreshSessionOutcome, type RefreshSessionParams } from './product/productAuthProvider'
import type { ProductTokenStore } from './product/tokenStore'

const CONTAINER_ID = 1
const CONTAINER_NAME = 'main'
const FIRST_CHUNK_TIMEOUT_MS = 3000
const ANALYZE_TIMEOUT_MS = 35_000
const REGISTRATION_TIMEOUT_MS = 35_000
const DAY_EVENTS_TIMEOUT_MS = 15_000
const UPCOMING_EVENTS_LIMIT = 5
const UPCOMING_EVENTS_TIMEOUT_MS = 15_000

/**
 * event_candidate系の結果(初回/followup共通)から確認・成功画面用のwhenTextを作る。
 * allDay===trueの時はstartLocal/endLocalを一切見ず、startDate/endDateExclusiveのみを使う。
 * 排他的終了日→利用者向け包含最終日の変換はscreens.formatAllDayCandidateWhen経由で
 * allDayDisplay.tsの共有関数だけが行う(ここでは独自の-1日計算をしない)。
 * 必要なフィールドが欠けている(不正な候補)場合はnullを返す。
 */
function candidateWhenText(candidate: {
  allDay: boolean
  startLocal: string | null
  endLocal: string | null
  startDate: string | null
  endDateExclusive: string | null
}): string | null {
  if (candidate.allDay) {
    if (!candidate.startDate || !candidate.endDateExclusive) return null
    return screens.formatAllDayCandidateWhen(candidate.startDate, candidate.endDateExclusive)
  }
  if (!candidate.startLocal || !candidate.endLocal) return null
  const start = parseLocalDateTime(candidate.startLocal)
  const end = parseLocalDateTime(candidate.endLocal)
  if (!start || !end) return null
  return screens.formatCandidateWhen(start, end)
}

/**
 * crypto.randomUUID()はSecure Context(HTTPS/localhost)でのみ利用可能で、
 * LAN上のプレーンHTTP開発サーバー(http://<LAN IP>:5173)のWebViewでは未定義/例外になる。
 * crypto.getRandomValues()はSecure Context要件がないため、こちらでUUID v4相当を自前生成する。
 */
export function generateRequestId(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export type ScreenId =
  | 'home'
  | 'recording'
  | 'captured'
  | 'tooShort'
  | 'analyzing'
  | 'candidate'
  | 'finalConfirm'
  | 'registering'
  | 'checkingStatus'
  | 'registered'
  | 'clarification'
  | 'followupReady'
  | 'followupRecording'
  | 'followupCaptured'
  | 'notCalendar'
  | 'dayLoading'
  | 'dayList'
  | 'dayEmpty'
  | 'dayError'
  | 'upcomingLoading'
  | 'upcomingList'
  | 'upcomingEmpty'
  | 'upcomingError'
  | 'eventDetailLoading'
  | 'eventDetail'
  | 'eventDetailMenu'
  | 'eventDetailError'
  | 'eventGone'
  | 'deleteConfirm'
  | 'deleting'
  | 'deleteError'
  | 'editRecording'
  | 'editCaptured'
  | 'editAnalyzing'
  | 'editNotUnderstood'
  | 'editConfirm'
  | 'editApplying'
  | 'editError'
  | 'error'
  | 'notConnected'
  | 'pairing'
  | 'pairingSuccess'
  | 'pairingError'

/**
 * main.ts が実際に使うSDKブリッジのメソッドだけを要求する最小インターフェース。
 * テストではFakeEvenAppBridgeを注入できるようにするための設計。
 */
export interface BridgeLike {
  createStartUpPageContainer(params: CreateStartUpPageContainer): Promise<number>
  textContainerUpgrade(params: TextContainerUpgrade): Promise<boolean>
  audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean>
  shutDownPageContainer(exitMode?: number): Promise<boolean>
  onEvenHubEvent(cb: (event: EvenHubEvent) => void): () => void
  setLocalStorage(key: string, value: string): Promise<boolean>
  getLocalStorage(key: string): Promise<string>
}

export interface App {
  start(): Promise<void>
  dispose(): void
  getScreen(): ScreenId
  getRecordingContext(): RecordingContext
  getAnalysisContext(): AnalysisContext
  getRegistrationContext(): RegistrationContext
  getFollowupRecordingContext(): RecordingContext
  getHomeMenuIndex(): number
  getDayEventsContext(): DayEventsContext
  getUpcomingEventsContext(): UpcomingEventsContext
  getPairingContext(): PairingContext
  getEventDetailContext(): EventDetailContext
  getEventDetailMenuIndex(): number
  getDeleteMutationContext(): EventMutationContext
  getEditRecordingContext(): RecordingContext
  getEditAnalysisContext(): EditAnalysisContext
  getEditApplyContext(): EventMutationContext
}

/**
 * テストではanalyzeAudioFn/registerCalendarEventFn/pollForCompletionFn/analyzeFollowupAudioFn/
 * cancelConversationFnにFakeを注入し、実バックエンド/Gemini/Calendarへは一切アクセスしない。
 * sessionToken/installIdは VITE_PLUGIN_SESSION_TOKEN/VITE_PLUGIN_INSTALL_ID から既定値を取る
 * (scripts/create-dev-session.ps1 が発行するローカル開発専用の値。本番配布方式ではない)。
 */
export interface AppDeps {
  analyzeAudioFn?: (params: AnalyzeAudioParams) => Promise<AnalyzeAudioOutcome>
  registerCalendarEventFn?: (params: RegisterEventParams) => Promise<RegisterEventOutcome>
  pollForCompletionFn?: (params: PollForCompletionParams) => Promise<CheckStatusOutcome>
  analyzeFollowupAudioFn?: (params: AnalyzeFollowupParams) => Promise<AnalyzeFollowupOutcome>
  cancelConversationFn?: (params: CancelConversationParams) => Promise<void>
  fetchDayEventsFn?: (params: FetchDayEventsParams) => Promise<FetchDayEventsOutcome>
  fetchUpcomingEventsFn?: (params: FetchUpcomingEventsParams) => Promise<FetchUpcomingEventsOutcome>
  fetchEventDetailFn?: (params: FetchEventDetailParams) => Promise<FetchEventDetailOutcome>
  updateCalendarEventDetailFn?: (params: UpdateEventParams) => Promise<UpdateEventOutcome>
  deleteCalendarEventDetailFn?: (params: DeleteEventParams) => Promise<DeleteEventOutcome>
  analyzeEditAudioFn?: (params: AnalyzeEditAudioParams) => Promise<AnalyzeEditAudioOutcome>
  baseUrl?: string
  sessionToken?: string
  installId?: string
  createRequestId?: () => string
  /**
   * 指定時はロケール自動検出(bridge保存値/navigator.languages)をスキップし、常にこの値を使う
   * (テスト用の決定的な注入経路)。未指定時はstart()内でdetectLocale()により解決する。
   */
  locale?: Locale
  analysisTimeoutMs?: number
  registrationTimeoutMs?: number
  registrationPollIntervalMs?: number
  registrationPollMaxAttempts?: number
  dayEventsTimeoutMs?: number
  upcomingEventsTimeoutMs?: number
  /**
   * 製品モード(Phase 2H)専用の依存。sessionTokenが空文字列(=devセッション未設定)の場合のみ
   * 製品モードとして扱われ、これらが使われる。devモードでは一切参照されない(既存動作を変えない)。
   */
  tokenStore?: ProductTokenStore
  productInstallationId?: string
  startPairingFn?: (params: StartPairingParams) => Promise<StartPairingOutcome>
  checkPairingStatusFn?: (params: CheckPairingStatusParams) => Promise<CheckPairingStatusOutcome>
  cancelPairingFn?: (params: CancelPairingParams) => Promise<void>
  exchangePairingFn?: (params: ExchangePairingParams) => Promise<ExchangePairingOutcome>
  refreshSessionFn?: (params: RefreshSessionParams) => Promise<RefreshSessionOutcome>
  pairingPollMaxDurationMs?: number
}

export function createApp(bridge: BridgeLike, deps: AppDeps = {}): App {
  const analyzeAudioFn = deps.analyzeAudioFn ?? analyzeAudio
  const registerCalendarEventFn = deps.registerCalendarEventFn ?? registerCalendarEvent
  const pollForCompletionFn = deps.pollForCompletionFn ?? pollForCompletion
  const analyzeFollowupAudioFn = deps.analyzeFollowupAudioFn ?? analyzeFollowupAudio
  const cancelConversationFn = deps.cancelConversationFn ?? cancelConversation
  const fetchDayEventsFn = deps.fetchDayEventsFn ?? fetchDayEvents
  const fetchUpcomingEventsFn = deps.fetchUpcomingEventsFn ?? fetchUpcomingEvents
  const fetchEventDetailFn = deps.fetchEventDetailFn ?? fetchEventDetail
  const updateCalendarEventDetailFn = deps.updateCalendarEventDetailFn ?? updateCalendarEventDetail
  const deleteCalendarEventDetailFn = deps.deleteCalendarEventDetailFn ?? deleteCalendarEventDetail
  const analyzeEditAudioFn = deps.analyzeEditAudioFn ?? analyzeEditAudio
  const baseUrl = deps.baseUrl ?? BACKEND_BASE_URL
  const sessionToken = deps.sessionToken ?? PLUGIN_SESSION_TOKEN
  const installId = deps.installId ?? PLUGIN_INSTALL_ID
  const createRequestId = deps.createRequestId ?? generateRequestId
  const analysisTimeoutMs = deps.analysisTimeoutMs ?? ANALYZE_TIMEOUT_MS
  const registrationTimeoutMs = deps.registrationTimeoutMs ?? REGISTRATION_TIMEOUT_MS
  const registrationPollIntervalMs = deps.registrationPollIntervalMs
  const registrationPollMaxAttempts = deps.registrationPollMaxAttempts
  const dayEventsTimeoutMs = deps.dayEventsTimeoutMs ?? DAY_EVENTS_TIMEOUT_MS
  const upcomingEventsTimeoutMs = deps.upcomingEventsTimeoutMs ?? UPCOMING_EVENTS_TIMEOUT_MS
  const configuredLocale = deps.locale

  // devセッション(sessionToken)が設定されていなければ製品モード。.env.local未設定の本番ビルドでは
  // sessionTokenは常に空文字列のため、これが自然に製品モードへフォールバックする。
  const isProductMode = sessionToken.length === 0
  const tokenStore = deps.tokenStore
  const productInstallationId = deps.productInstallationId ?? ''
  const startPairingFn = deps.startPairingFn ?? startPairing
  const checkPairingStatusFn = deps.checkPairingStatusFn ?? checkPairingStatus
  const cancelPairingFn = deps.cancelPairingFn ?? cancelPairing
  const exchangePairingFn = deps.exchangePairingFn ?? exchangePairing
  const pairingPollMaxDurationMs = deps.pairingPollMaxDurationMs ?? 10 * 60 * 1000
  const DEFAULT_PAIRING_POLL_INTERVAL_SECONDS = 3

  let currentScreen: ScreenId = 'home'
  let homeMenuIndex = 0
  let recordingContext: RecordingContext = initialRecordingContext
  let analysisContext: AnalysisContext = initialAnalysisContext
  let registrationContext: RegistrationContext = initialRegistrationContext
  let followupRecordingContext: RecordingContext = initialRecordingContext
  let dayEventsContext: DayEventsContext = initialDayEventsContext
  let upcomingEventsContext: UpcomingEventsContext = initialUpcomingEventsContext
  let analysisAbortController: AbortController | null = null
  let registrationAbortController: AbortController | null = null
  let dayEventsAbortController: AbortController | null = null
  let upcomingEventsAbortController: AbortController | null = null
  let currentCandidateId: string | null = null
  let currentConversationId: string | null = null
  const buffer = new PcmBuffer()
  const followupBuffer = new PcmBuffer()

  // 予定詳細/編集/削除フロー(Phase 2I)専用の状態。selectedEventId/selectedEventOriginは
  // メモリ上にのみ保持し、画面表示にもbridge.setLocalStorageにも一切出さない(旧eventKeyと違い実IDのため)。
  type EventListOrigin = 'today' | 'tomorrow' | 'upcoming'
  let selectedEventId: string | null = null
  let selectedEventOrigin: EventListOrigin | null = null
  let eventDetailContext: EventDetailContext = initialEventDetailContext
  let eventDetailAbortController: AbortController | null = null
  let eventDetailMenuIndex = 0
  let deleteMutationContext: EventMutationContext = initialEventMutationContext
  let deleteAbortController: AbortController | null = null
  let editRecordingContext: RecordingContext = initialRecordingContext
  const editBuffer = new PcmBuffer()
  let editAnalysisContext: EditAnalysisContext = initialEditAnalysisContext
  let editAnalysisAbortController: AbortController | null = null
  let pendingEditFields: EditInstructionFields = {}
  let editApplyContext: EventMutationContext = initialEventMutationContext
  let editApplyAbortController: AbortController | null = null
  // 編集確定/削除確定で新規発行し、同一ユーザー操作の再試行時は使い回す(サーバー側の重複適用防止のため)。
  let currentMutationIdempotencyKey: string | null = null

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  let firstChunkTimer: ReturnType<typeof setTimeout> | null = null
  let receivedFirstChunk = false

  let listenerAttached = false
  let unsubscribe: (() => void) | null = null
  let renderChain: Promise<unknown> = Promise.resolve()
  let disposed = false

  let pairingContext: PairingContext = initialPairingContext
  let pairingAbortController: AbortController | null = null
  let pairingPollTimer: ReturnType<typeof setTimeout> | null = null
  let pairingStartedAt: number | null = null

  function clearPairingPollTimer(): void {
    if (pairingPollTimer !== null) {
      clearTimeout(pairingPollTimer)
      pairingPollTimer = null
    }
  }

  /**
   * 予定詳細/編集/削除フローの進行中状態を全て破棄する。goHome()・フォアグラウンド復帰・製品モード
   * 切断時など「安全な画面へ戻る」経路すべてから呼ばれる共通処理(仕様: バックグラウンド遷移時は
   * 編集/削除の確認途中状態を復元しない)。selectedEventId/selectedEventOriginはメモリ上の値であり、
   * ここでnullに戻すだけでよい(永続化された値は元々存在しない)。
   */
  function resetEventDetailFlow(): void {
    eventDetailAbortController?.abort()
    eventDetailAbortController = null
    eventDetailContext = initialEventDetailContext
    eventDetailMenuIndex = 0
    deleteAbortController?.abort()
    deleteAbortController = null
    deleteMutationContext = initialEventMutationContext
    editRecordingContext = initialRecordingContext
    editBuffer.clear()
    editAnalysisAbortController?.abort()
    editAnalysisAbortController = null
    editAnalysisContext = initialEditAnalysisContext
    pendingEditFields = {}
    editApplyAbortController?.abort()
    editApplyAbortController = null
    editApplyContext = initialEventMutationContext
    currentMutationIdempotencyKey = null
    selectedEventId = null
    selectedEventOrigin = null
  }

  /**
   * refresh失敗時、TokenStoreのclear自体はProductAuthManagerが行う。ここではawaitされる
   * onDisconnectedとして、進行中の状態を全てリセットしてから未接続画面を表示する。これが完了する前に
   * handleAuthFailure()自身は解決しないため、呼び出し元(withProductAuthRetry経由)の古い状態ガードが
   * 正しく効き、未接続画面をエラー画面で上書きすることはない。
   */
  async function handleProductDisconnected(): Promise<void> {
    clearWatchdog()
    clearFirstChunkTimer()
    await stopMicrophone()
    buffer.clear()
    recordingContext = initialRecordingContext
    followupBuffer.clear()
    followupRecordingContext = initialRecordingContext
    analysisAbortController?.abort()
    analysisAbortController = null
    analysisContext = initialAnalysisContext
    registrationAbortController?.abort()
    registrationAbortController = null
    registrationContext = initialRegistrationContext
    currentCandidateId = null
    dayEventsAbortController?.abort()
    dayEventsAbortController = null
    dayEventsContext = initialDayEventsContext
    upcomingEventsAbortController?.abort()
    upcomingEventsAbortController = null
    upcomingEventsContext = initialUpcomingEventsContext
    homeMenuIndex = 0
    resetEventDetailFlow()
    currentConversationId = null // TokenStoreは既にclear済みのため、cancel APIは呼ばない(呼んでも401になるだけ)
    clearPairingPollTimer()
    pairingAbortController?.abort()
    pairingAbortController = null
    pairingContext = initialPairingContext
    logSafe({ event: 'product_disconnected' })
    await showScreen('notConnected', screens.notConnectedScreenText())
  }

  const authManager: ProductAuthManager | null =
    isProductMode && tokenStore
      ? new ProductAuthManager({
          tokenStore,
          baseUrl,
          installationId: productInstallationId,
          ...(deps.refreshSessionFn ? { refreshFn: deps.refreshSessionFn } : {}),
          onDisconnected: () => handleProductDisconnected(),
        })
      : null

  async function resolveAuthForCall(): Promise<{ sessionToken: string; installId: string } | null> {
    if (!isProductMode) return { sessionToken, installId }
    if (!authManager) return null
    const accessToken = await authManager.getAccessToken()
    if (!accessToken) return null
    return { sessionToken: accessToken, installId: productInstallationId }
  }

  /**
   * 製品モードの共通認可プロバイダ(フェーズ2H・セクション10)。devモードでは常に既存のsessionToken/
   * installIdをそのまま使うだけで、refresh/retryロジックには一切入らない(既存動作を変えない)。
   * 401(auth_failed)到達時のみ1回だけrefreshし、成功時のみ元のリクエストを1回だけ再試行する。
   * refresh失敗時はProductAuthManager側でTokenStoreがclearされ、未接続画面へ遷移した後にこの関数は
   * 古い(依然auth_failedの)outcomeをそのまま返すため、呼び出し元の状態ガードで安全に無視される。
   */
  async function withProductAuthRetry<
    P extends { sessionToken: string; installId: string },
    O extends { kind: string },
  >(buildParams: (auth: { sessionToken: string; installId: string }) => P, callFn: (params: P) => Promise<O>): Promise<O | { kind: 'auth_failed' }> {
    // devモードでは既存動作の呼び出しタイミング(マイクロタスク数)を変えないため、
    // resolveAuthForCall()自体を経由せず直接callFnへ委譲する(refresh/retryロジックには一切入らない)。
    if (!isProductMode) {
      return callFn(buildParams({ sessionToken, installId }))
    }

    const auth = await resolveAuthForCall()
    if (!auth) return { kind: 'auth_failed' }
    const outcome = await callFn(buildParams(auth))
    if (outcome.kind !== 'auth_failed' || !authManager) return outcome
    const refreshed = await authManager.handleAuthFailure()
    if (!refreshed) return outcome
    const retryAuth = await resolveAuthForCall()
    if (!retryAuth) return outcome
    return callFn(buildParams(retryAuth))
  }

  function fireAndForgetCancelConversation(conversationId: string): void {
    void resolveAuthForCall()
      .then((auth) => (auth ? cancelConversationFn({ baseUrl, sessionToken: auth.sessionToken, installId: auth.installId, conversationId }) : undefined))
      .catch(() => {})
  }

  // マイクが開いていると認識している間だけtrue。stopMicrophone()はこのフラグを
  // 同期的に(await前に)falseへ倒してから呼び出すため、finishRecording/cancelRecording/
  // handleAudioEventTimeout/handleForegroundExit/disposeのいずれから呼ばれても
  // bridge.audioControl(false)は録音1回につき最大1回しか実行されない。
  let micOpen = false

  // 公式SDKの型定義はaudioControl(false)がPromise<boolean>を返すとしているが、
  // 公式asrテンプレートの停止処理はこの戻り値をawaitも判定もしていない(例外を投げないことのみを
  // 成功の基準にしている)。実機では戻り値が厳密なtrueにならない場合があるため、本アプリでも
  // 「例外が投げられたか」だけをマイク停止自体の失敗基準とする。
  async function stopMicrophone(): Promise<boolean> {
    if (!micOpen) return true
    micOpen = false
    try {
      await bridge.audioControl(false)
      return true
    } catch {
      return false
    }
  }

  function clearWatchdog(): void {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
  }

  function clearFirstChunkTimer(): void {
    if (firstChunkTimer !== null) {
      clearTimeout(firstChunkTimer)
      firstChunkTimer = null
    }
  }

  function render(text: string): Promise<void> {
    renderChain = renderChain
      .then(() =>
        bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: CONTAINER_ID,
            containerName: CONTAINER_NAME,
            content: text,
            contentOffset: 0,
            contentLength: 0,
          }),
        ),
      )
      .catch(() => {
        // 描画失敗はUI更新の失敗であり、アプリの状態機械自体は継続する。
      })
    return renderChain as Promise<void>
  }

  function showScreen(screen: ScreenId, text: string): Promise<void> {
    currentScreen = screen
    return render(text)
  }

  async function goHome(): Promise<void> {
    recordingContext = recordingReducer(recordingContext, { type: 'RESET' })
    analysisContext = analysisReducer(analysisContext, { type: 'RESET' })
    registrationContext = registrationReducer(registrationContext, { type: 'RESET' })
    followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'RESET' })
    currentCandidateId = null
    followupBuffer.clear()

    dayEventsAbortController?.abort()
    dayEventsAbortController = null
    dayEventsContext = dayEventsReducer(dayEventsContext, { type: 'RESET' })
    upcomingEventsAbortController?.abort()
    upcomingEventsAbortController = null
    upcomingEventsContext = upcomingEventsReducer(upcomingEventsContext, { type: 'RESET' })
    homeMenuIndex = 0
    resetEventDetailFlow()

    // 会話が残っていればbest-effortでキャンセルする(画面遷移はブロックしない)。
    if (currentConversationId !== null) {
      const conversationId = currentConversationId
      currentConversationId = null
      fireAndForgetCancelConversation(conversationId)
    }

    await showScreen('home', screens.homeScreenText(homeMenuIndex))
  }

  async function beginRecording(): Promise<void> {
    recordingContext = recordingReducer(recordingContext, { type: 'START' })
    buffer.clear()
    receivedFirstChunk = false

    let started = false
    try {
      started = await bridge.audioControl(true, AudioInputSource.Glasses)
    } catch {
      started = false
    }

    if (!started) {
      recordingContext = recordingReducer(recordingContext, { type: 'START_FAILED', errorCode: 'audio_start_failed' })
      logSafe({ event: 'audio_start_failed', state: recordingContext.state, startResult: false })
      await showScreen('error', screens.errorScreenText(errorMessage('audio_start_failed')))
      return
    }

    micOpen = true
    recordingContext = recordingReducer(recordingContext, { type: 'STARTED' })
    logSafe({ event: 'recording_started', state: recordingContext.state, startResult: true })
    await showScreen('recording', screens.recordingScreenText())

    clearWatchdog()
    watchdogTimer = setTimeout(() => {
      void finishRecording()
    }, MAX_RECORDING_SECONDS * 1000)

    clearFirstChunkTimer()
    firstChunkTimer = setTimeout(() => {
      if (!receivedFirstChunk) {
        void handleAudioEventTimeout()
      }
    }, FIRST_CHUNK_TIMEOUT_MS)
  }

  async function handleAudioEventTimeout(): Promise<void> {
    if (recordingContext.state !== 'recording') return
    clearWatchdog()
    clearFirstChunkTimer()
    await stopMicrophone()
    buffer.clear()
    recordingContext = recordingReducer(recordingContext, { type: 'ERROR', errorCode: 'audio_event_timeout' })
    logSafe({ event: 'audio_event_timeout', state: recordingContext.state })
    await showScreen('error', screens.errorScreenText(errorMessage('audio_event_timeout')))
  }

  async function finishRecording(): Promise<void> {
    if (recordingContext.state !== 'recording') return
    clearWatchdog()
    clearFirstChunkTimer()
    recordingContext = recordingReducer(recordingContext, { type: 'STOP' })

    const stopOk = await stopMicrophone()

    logSafe({
      event: 'audio_stop',
      state: recordingContext.state,
      stopResult: stopOk,
      chunkCount: buffer.chunkCount,
      totalBytes: buffer.byteLength,
      seconds: buffer.seconds,
    })

    if (!stopOk) {
      // マイク停止自体(audioControl(false))が例外を投げた場合のみ、ここに到達する。
      recordingContext = recordingReducer(recordingContext, { type: 'STOP_FAILED', errorCode: 'audio_stop_failed' })
      buffer.clear()
      await showScreen('error', screens.errorScreenText(errorMessage('audio_stop_failed')))
      return
    }

    // マイク停止自体は成功している。以降はPCM結合・秒数計算・画面更新の後処理であり、
    // ここで例外が起きても「マイク停止失敗」とは区別された別のエラーとして扱う。
    try {
      const seconds = buffer.seconds
      if (seconds < MIN_RECORDING_SECONDS) {
        buffer.clear()
        recordingContext = recordingReducer(recordingContext, { type: 'RESET' })
        await showScreen('tooShort', screens.tooShortScreenText())
        return
      }

      recordingContext = recordingReducer(recordingContext, { type: 'STOPPED', durationSec: seconds })
      await showScreen('captured', screens.capturedScreenText(seconds))
    } catch {
      buffer.clear()
      recordingContext = recordingReducer(recordingContext, { type: 'STOP_FAILED', errorCode: 'audio_processing_failed' })
      await showScreen('error', screens.errorScreenText(errorMessage('audio_processing_failed')))
    }
  }

  async function cancelRecording(): Promise<void> {
    if (recordingContext.state !== 'recording') return
    clearWatchdog()
    clearFirstChunkTimer()
    recordingContext = recordingReducer(recordingContext, { type: 'CANCEL' })
    await stopMicrophone()
    buffer.clear()
    recordingContext = recordingReducer(recordingContext, { type: 'CANCELLED' })
    logSafe({ event: 'recording_cancelled', state: recordingContext.state })
    await goHome()
  }

  async function startAnalysis(): Promise<void> {
    // analysisContext.stateも見ることで、'analyzing'への画面遷移が何らかの理由で完了しないまま
    // currentScreenが'captured'に留まった場合でも、単押しの多重実行(=Gemini/fetchの二重呼び出し)を防ぐ。
    if (recordingContext.state !== 'captured' || analysisContext.state === 'analyzing') return

    // 状態と画面表示を最初に同期的に更新する。WAV変換やrequestId生成などで例外が起きても、
    // 「押しても無反応」に見える状態には陥らない(必ずanalyzing表示かerror表示のどちらかになる)。
    analysisContext = analysisReducer(analysisContext, { type: 'START' })
    await showScreen('analyzing', screens.analyzingScreenText())

    // showScreen()の描画待ち(await)の間に二度押しキャンセルが割り込み得るため、
    // AbortController生成・fetch開始の前に状態を再確認する。
    if (analysisContext.state !== 'analyzing') return

    let wav: Uint8Array
    let requestId: string
    try {
      const pcm = buffer.concat()
      buffer.clear()
      wav = encodeWav(pcm)
      requestId = createRequestId()
    } catch {
      analysisContext = analysisReducer(analysisContext, { type: 'FAILED', errorCode: 'analysis_failed' })
      logSafe({ event: 'analyze_audio_failed', errorCode: 'analysis_failed' })
      await showScreen('error', screens.errorScreenText(errorMessage('analysis_failed')))
      return
    }

    const controller = new AbortController()
    analysisAbortController = controller

    logSafe({ event: 'analyze_audio_started', wavBytes: wav.byteLength })

    const outcome = await withProductAuthRetry(
      (auth) => ({
        wav,
        baseUrl,
        sessionToken: auth.sessionToken,
        installId: auth.installId,
        requestId,
        signal: controller.signal,
        timeoutMs: analysisTimeoutMs,
        locale: getActiveLocale(),
      }),
      analyzeAudioFn,
    )

    // 二度押しキャンセル等で既に別の状態へ遷移済みなら、遅延して届いた結果は画面へ反映しない。
    if (analysisContext.state !== 'analyzing' || analysisAbortController !== controller) {
      return
    }
    analysisAbortController = null

    if (outcome.kind === 'aborted') {
      return
    }

    if (outcome.kind !== 'success') {
      const errorCode =
        outcome.kind === 'auth_failed'
          ? 'analysis_auth_failed'
          : outcome.kind === 'timeout'
            ? 'analysis_timeout'
            : outcome.kind === 'rate_limited'
              ? 'analysis_rate_limited'
              : outcome.kind === 'network_error'
                ? 'analysis_network_error'
                : 'analysis_failed'
      analysisContext = analysisReducer(analysisContext, { type: 'FAILED', errorCode })
      logSafe({ event: 'analyze_audio_failed', errorCode })
      await showScreen('error', screens.errorScreenText(errorMessage(errorCode)))
      return
    }

    const result = outcome.result
    logSafe({ event: 'analyze_audio_succeeded', resultType: result.resultType })

    if (result.resultType === 'event_candidate') {
      const nowLocal = nowLocalIsoTokyo()
      const whenText = validateEventCandidateTiming(result, nowLocal) ? candidateWhenText(result) : null

      if (whenText === null) {
        analysisContext = analysisReducer(analysisContext, { type: 'FAILED', errorCode: 'analysis_failed' })
        logSafe({ event: 'analyze_audio_failed', errorCode: 'analysis_failed' })
        await showScreen('error', screens.errorScreenText(errorMessage('analysis_failed')))
        return
      }

      analysisContext = analysisReducer(analysisContext, { type: 'SUCCEEDED', result })
      currentCandidateId = outcome.candidateId
      await showScreen('candidate', screens.candidateScreenText(result.title ?? '', whenText))
      return
    }

    if (result.resultType === 'needs_clarification') {
      analysisContext = analysisReducer(analysisContext, { type: 'SUCCEEDED', result })
      currentConversationId = outcome.conversationId
      await showScreen('clarification', screens.clarificationScreenText(result.clarificationQuestion ?? ''))
      return
    }

    analysisContext = analysisReducer(analysisContext, { type: 'SUCCEEDED', result })
    await showScreen('notCalendar', screens.notCalendarScreenText())
  }

  async function cancelAnalysis(): Promise<void> {
    if (analysisContext.state !== 'analyzing') return
    analysisAbortController?.abort()
    analysisAbortController = null
    analysisContext = analysisReducer(analysisContext, { type: 'CANCELLED' })
    logSafe({ event: 'analyze_audio_cancelled', state: analysisContext.state })
    // goHome()が会話の破棄(best-effort cancel)も行うため、追加入力中の中止もここで正しく処理される。
    await goHome()
  }

  /** FollowupResult(cancelledを含む)をEventCandidateResultへ変換する。cancelled分岐は呼び出し側で先に処理済みの前提。 */
  function toEventCandidateResult(result: FollowupResult): EventCandidateResult {
    return { ...result, resultType: result.resultType as EventCandidateResult['resultType'] }
  }

  /** clarification画面の単押し: まだ録音を始めず、回答準備画面へ移動するだけ。 */
  async function startFollowupReady(): Promise<void> {
    if (analysisContext.state !== 'succeeded' || currentConversationId === null) return
    if (analysisContext.result?.resultType !== 'needs_clarification') return
    await showScreen('followupReady', screens.followupReadyScreenText())
  }

  async function handleFollowupAudioEventTimeout(): Promise<void> {
    if (followupRecordingContext.state !== 'recording') return
    clearWatchdog()
    clearFirstChunkTimer()
    await stopMicrophone()
    followupBuffer.clear()
    followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'ERROR', errorCode: 'audio_event_timeout' })
    logSafe({ event: 'followup_audio_event_timeout', state: followupRecordingContext.state })
    await showScreen('error', screens.errorScreenText(errorMessage('audio_event_timeout')))
  }

  /** followupReady画面の単押しでのみ呼ばれる。初回録音とは別のバッファ・状態機械を使う。 */
  async function beginFollowupRecording(): Promise<void> {
    if (currentScreen !== 'followupReady') return
    followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'START' })
    followupBuffer.clear()
    receivedFirstChunk = false

    let started = false
    try {
      started = await bridge.audioControl(true, AudioInputSource.Glasses)
    } catch {
      started = false
    }

    if (!started) {
      followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'START_FAILED', errorCode: 'audio_start_failed' })
      logSafe({ event: 'followup_audio_start_failed', state: followupRecordingContext.state, startResult: false })
      await showScreen('error', screens.errorScreenText(errorMessage('audio_start_failed')))
      return
    }

    micOpen = true
    followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'STARTED' })
    logSafe({ event: 'followup_recording_started', state: followupRecordingContext.state, startResult: true })
    await showScreen('followupRecording', screens.followupRecordingScreenText())

    clearWatchdog()
    watchdogTimer = setTimeout(() => {
      void finishFollowupRecording()
    }, MAX_RECORDING_SECONDS * 1000)

    clearFirstChunkTimer()
    firstChunkTimer = setTimeout(() => {
      if (!receivedFirstChunk) {
        void handleFollowupAudioEventTimeout()
      }
    }, FIRST_CHUNK_TIMEOUT_MS)
  }

  async function finishFollowupRecording(): Promise<void> {
    if (followupRecordingContext.state !== 'recording') return
    clearWatchdog()
    clearFirstChunkTimer()
    followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'STOP' })

    const stopOk = await stopMicrophone()
    logSafe({
      event: 'followup_audio_stop',
      state: followupRecordingContext.state,
      stopResult: stopOk,
      chunkCount: followupBuffer.chunkCount,
      totalBytes: followupBuffer.byteLength,
      seconds: followupBuffer.seconds,
    })

    if (!stopOk) {
      followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'STOP_FAILED', errorCode: 'audio_stop_failed' })
      followupBuffer.clear()
      await showScreen('error', screens.errorScreenText(errorMessage('audio_stop_failed')))
      return
    }

    try {
      const seconds = followupBuffer.seconds
      if (seconds < MIN_RECORDING_SECONDS) {
        followupBuffer.clear()
        followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'RESET' })
        await showScreen('tooShort', screens.tooShortScreenText())
        return
      }

      followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'STOPPED', durationSec: seconds })
      await showScreen('followupCaptured', screens.followupCapturedScreenText(seconds))
    } catch {
      followupBuffer.clear()
      followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'STOP_FAILED', errorCode: 'audio_processing_failed' })
      await showScreen('error', screens.errorScreenText(errorMessage('audio_processing_failed')))
    }
  }

  async function cancelFollowupRecording(): Promise<void> {
    if (followupRecordingContext.state !== 'recording') return
    clearWatchdog()
    clearFirstChunkTimer()
    followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'CANCEL' })
    await stopMicrophone()
    followupBuffer.clear()
    followupRecordingContext = recordingReducer(followupRecordingContext, { type: 'CANCELLED' })
    logSafe({ event: 'followup_recording_cancelled', state: followupRecordingContext.state })
    // goHome()が会話のbest-effortキャンセルも行う。
    await goHome()
  }

  /**
   * followupCaptured画面の単押しでのみ呼ばれる。初回のstartAnalysis()と同様、
   * 例外が起きても「押しても無反応」に陥らないよう、状態遷移を先に確定させてから送信する。
   */
  async function startFollowupAnalysis(): Promise<void> {
    if (followupRecordingContext.state !== 'captured' || currentConversationId === null || analysisContext.state === 'analyzing') {
      return
    }

    analysisContext = analysisReducer(analysisContext, { type: 'START' })
    await showScreen('analyzing', screens.analyzingScreenText())
    if (analysisContext.state !== 'analyzing') return

    let wav: Uint8Array
    let requestId: string
    try {
      const pcm = followupBuffer.concat()
      followupBuffer.clear()
      wav = encodeWav(pcm)
      requestId = createRequestId()
    } catch {
      analysisContext = analysisReducer(analysisContext, { type: 'FAILED', errorCode: 'analysis_failed' })
      logSafe({ event: 'analyze_followup_audio_failed', errorCode: 'analysis_failed' })
      await showScreen('error', screens.errorScreenText(errorMessage('analysis_failed')))
      return
    }

    const controller = new AbortController()
    analysisAbortController = controller
    const conversationId = currentConversationId

    logSafe({ event: 'analyze_followup_audio_started', wavBytes: wav.byteLength })

    const outcome = await withProductAuthRetry(
      (auth) => ({
        wav,
        baseUrl,
        sessionToken: auth.sessionToken,
        installId: auth.installId,
        requestId,
        conversationId,
        signal: controller.signal,
        timeoutMs: analysisTimeoutMs,
        locale: getActiveLocale(),
      }),
      analyzeFollowupAudioFn,
    )

    if (analysisContext.state !== 'analyzing' || analysisAbortController !== controller) {
      return
    }
    analysisAbortController = null

    if (outcome.kind === 'aborted') {
      return
    }

    if (outcome.kind !== 'success') {
      const errorCode: ErrorCode =
        outcome.kind === 'auth_failed'
          ? 'analysis_auth_failed'
          : outcome.kind === 'conversation_expired'
            ? 'followup_conversation_expired'
            : outcome.kind === 'timeout'
              ? 'analysis_timeout'
              : outcome.kind === 'network_error'
                ? 'analysis_network_error'
                : 'analysis_failed'
      currentConversationId = null
      analysisContext = analysisReducer(analysisContext, { type: 'FAILED', errorCode })
      logSafe({ event: 'analyze_followup_audio_failed', errorCode })
      await showScreen('error', screens.errorScreenText(errorMessage(errorCode)))
      return
    }

    const result = outcome.result
    logSafe({ event: 'analyze_followup_audio_succeeded', resultType: result.resultType })

    if (result.resultType === 'event_candidate') {
      const nowLocal = nowLocalIsoTokyo()
      const whenText = validateFollowupCandidateTiming(result, nowLocal) ? candidateWhenText(result) : null

      if (whenText === null) {
        currentConversationId = null
        analysisContext = analysisReducer(analysisContext, { type: 'FAILED', errorCode: 'analysis_failed' })
        logSafe({ event: 'analyze_followup_audio_failed', errorCode: 'analysis_failed' })
        await showScreen('error', screens.errorScreenText(errorMessage('analysis_failed')))
        return
      }

      currentConversationId = null // 会話は完了し、以後は既存candidateフローのみを使う
      currentCandidateId = outcome.candidateId
      analysisContext = analysisReducer(analysisContext, { type: 'SUCCEEDED', result: toEventCandidateResult(result) })
      await showScreen('candidate', screens.candidateScreenText(result.title ?? '', whenText))
      return
    }

    if (result.resultType === 'needs_clarification') {
      currentConversationId = outcome.conversationId
      analysisContext = analysisReducer(analysisContext, { type: 'SUCCEEDED', result: toEventCandidateResult(result) })
      await showScreen('clarification', screens.clarificationScreenText(result.clarificationQuestion ?? ''))
      return
    }

    if (result.resultType === 'not_calendar_request') {
      currentConversationId = null
      analysisContext = analysisReducer(analysisContext, { type: 'SUCCEEDED', result: toEventCandidateResult(result) })
      await showScreen('notCalendar', screens.notCalendarScreenText())
      return
    }

    // cancelled: 明示キャンセル、または3ターンで未完成のため打ち切り。候補を作らずホームへ。
    currentConversationId = null
    analysisContext = analysisReducer(analysisContext, { type: 'CANCELLED' })
    await goHome()
  }

  type CandidateFields =
    | { candidateId: string; title: string; timeZone: string; allDay: false; startLocal: string; endLocal: string }
    | { candidateId: string; title: string; timeZone: string; allDay: true; startDate: string; endDateExclusive: string }

  /**
   * allDayに応じて必要なフィールドが揃っている場合のみ候補を返す(判別共用体で、
   * timed/終日のフィールドが混在した不完全な候補をそのまま画面や登録POSTへ渡さない)。
   */
  function currentCandidateFields(): CandidateFields | null {
    if (analysisContext.state !== 'succeeded' || currentCandidateId === null) return null
    const result = analysisContext.result
    if (!result || result.resultType !== 'event_candidate') return null

    if (result.allDay) {
      if (!result.startDate || !result.endDateExclusive) return null
      return {
        candidateId: currentCandidateId,
        title: result.title ?? '',
        timeZone: result.timeZone,
        allDay: true,
        startDate: result.startDate,
        endDateExclusive: result.endDateExclusive,
      }
    }

    if (!result.startLocal || !result.endLocal) return null
    return {
      candidateId: currentCandidateId,
      title: result.title ?? '',
      timeZone: result.timeZone,
      allDay: false,
      startLocal: result.startLocal,
      endLocal: result.endLocal,
    }
  }

  /** candidate画面の単押し: まだCalendarへは登録せず、最終確認画面へ移動するだけ。 */
  async function showFinalConfirm(): Promise<void> {
    const candidate = currentCandidateFields()
    if (!candidate) return
    const whenText = candidateWhenText(
      candidate.allDay
        ? { allDay: true, startLocal: null, endLocal: null, startDate: candidate.startDate, endDateExclusive: candidate.endDateExclusive }
        : { allDay: false, startLocal: candidate.startLocal, endLocal: candidate.endLocal, startDate: null, endDateExclusive: null },
    )
    if (whenText === null) return
    await showScreen('finalConfirm', screens.finalConfirmScreenText(candidate.title, whenText))
  }

  async function finishRegistrationSuccess(candidate: CandidateFields): Promise<void> {
    registrationContext = registrationReducer(registrationContext, { type: 'SUCCEEDED' })
    logSafe({ event: 'calendar_event_registered' })
    currentCandidateId = null
    const whenText =
      candidateWhenText(
        candidate.allDay
          ? { allDay: true, startLocal: null, endLocal: null, startDate: candidate.startDate, endDateExclusive: candidate.endDateExclusive }
          : { allDay: false, startLocal: candidate.startLocal, endLocal: candidate.endLocal, startDate: null, endDateExclusive: null },
      ) ?? ''
    await showScreen('registered', screens.registeredScreenText(whenText))
  }

  function registrationErrorCode(outcome: RegisterEventOutcome): ErrorCode {
    switch (outcome.kind) {
      case 'auth_failed':
        return 'registration_auth_failed'
      case 'candidate_expired':
        return 'registration_candidate_expired'
      case 'oauth_not_connected':
        return 'registration_oauth_not_connected'
      default:
        return 'registration_failed'
    }
  }

  /**
   * 最終確認画面の単押しでのみ呼ばれる。押下直後に同期的にregistering状態・画面へ遷移してから
   * POST /plugin/calendar-events を送る。自動リトライはしない。timeout/network_errorの場合のみ、
   * 読み取り専用のstatus確認を最大3回・2秒間隔で行い、completedであれば成功として扱う。
   */
  async function startRegistration(): Promise<void> {
    const candidate = currentCandidateFields()
    if (!candidate || registrationContext.state === 'registering' || registrationContext.state === 'checkingStatus') return

    registrationContext = registrationReducer(registrationContext, { type: 'START' })
    await showScreen('registering', screens.registeringScreenText())

    // showScreen()の描画待ちの間に何らかの理由で状態が変わっていないか再確認してから送信する。
    if (registrationContext.state !== 'registering') return

    const requestId = createRequestId()
    const controller = new AbortController()
    registrationAbortController = controller

    const outcome = await withProductAuthRetry(
      (auth) =>
        candidate.allDay
          ? {
              baseUrl,
              sessionToken: auth.sessionToken,
              installId: auth.installId,
              requestId,
              candidateId: candidate.candidateId,
              title: candidate.title,
              timeZone: candidate.timeZone,
              allDay: true as const,
              startDate: candidate.startDate,
              endDateExclusive: candidate.endDateExclusive,
              signal: controller.signal,
              timeoutMs: registrationTimeoutMs,
              locale: getActiveLocale(),
            }
          : {
              baseUrl,
              sessionToken: auth.sessionToken,
              installId: auth.installId,
              requestId,
              candidateId: candidate.candidateId,
              title: candidate.title,
              timeZone: candidate.timeZone,
              allDay: false as const,
              startLocal: candidate.startLocal,
              endLocal: candidate.endLocal,
              signal: controller.signal,
              timeoutMs: registrationTimeoutMs,
              locale: getActiveLocale(),
            },
      registerCalendarEventFn,
    )

    if (registrationContext.state !== 'registering' || registrationAbortController !== controller) {
      return
    }
    registrationAbortController = null

    if (outcome.kind === 'aborted') {
      return
    }

    if (outcome.kind === 'success') {
      await finishRegistrationSuccess(candidate)
      return
    }

    if (outcome.kind === 'timeout' || outcome.kind === 'network_error') {
      registrationContext = registrationReducer(registrationContext, { type: 'CHECK_STATUS' })
      await showScreen('checkingStatus', screens.checkingStatusScreenText())

      const pollOutcome = await withProductAuthRetry(
        (auth) => ({
          baseUrl,
          sessionToken: auth.sessionToken,
          installId: auth.installId,
          candidateId: candidate.candidateId,
          ...(registrationPollIntervalMs !== undefined ? { intervalMs: registrationPollIntervalMs } : {}),
          ...(registrationPollMaxAttempts !== undefined ? { maxAttempts: registrationPollMaxAttempts } : {}),
        }),
        pollForCompletionFn,
      )

      if (registrationContext.state !== 'checkingStatus') return

      if (pollOutcome.kind === 'status' && pollOutcome.status === 'completed') {
        await finishRegistrationSuccess(candidate)
        return
      }

      registrationContext = registrationReducer(registrationContext, { type: 'FAILED', errorCode: 'registration_failed' })
      logSafe({ event: 'calendar_event_register_failed', errorCode: 'registration_failed' })
      await showScreen('error', screens.errorScreenText(errorMessage('registration_failed')))
      return
    }

    const errorCode = registrationErrorCode(outcome)
    registrationContext = registrationReducer(registrationContext, { type: 'FAILED', errorCode })
    logSafe({ event: 'calendar_event_register_failed', errorCode })
    await showScreen('error', screens.errorScreenText(errorMessage(errorCode)))
  }

  /** ホームメニューと同じ3件ウィンドウの選択カーソルで表示する(旧: 3件区切りのページ送り)。 */
  function dayListScreenText(): string {
    if (dayEventsContext.state !== 'loaded' || dayEventsContext.day === null || dayEventsContext.dateLocal === null) {
      return ''
    }
    const dateLocal = dayEventsContext.dateLocal
    const total = dayEventsContext.events.length
    const selectedIndex = dayEventsContext.selectedIndex
    const start = screens.windowStart(selectedIndex, total, DAY_EVENTS_PER_PAGE)
    const windowItems = dayEventsContext.events.slice(start, start + DAY_EVENTS_PER_PAGE)
    const lines = windowItems.map((event, i) => {
      const formatted = formatDayEventLine(event, dateLocal)
      return start + i === selectedIndex ? `> ${formatted}` : `  ${formatted}`
    })
    const isLastWindow = start + windowItems.length >= total
    return screens.dayEventsScreenText(dayEventsContext.day, selectedIndex, total, lines, isLastWindow, dayEventsContext.truncated)
  }

  async function renderDayList(): Promise<void> {
    await showScreen('dayList', dayListScreenText())
  }

  /** ホーム画面の「今日の予定」「明日の予定」の単押しでのみ呼ばれる。二重送信防止のため、直前がhome画面の時だけ受け付ける。 */
  async function startDayEvents(day: DayKind): Promise<void> {
    if (currentScreen !== 'home') return
    await runDayEventsFetch(day)
  }

  /**
   * 実際のfetchロジック本体。ホームからの初回取得と、削除成功後/予定が他端末で更新・削除された後の
   * 「一覧を再取得して戻る」の両方から呼ばれるため、startDayEvents()の"直前がhome画面"ガードとは分離してある。
   */
  async function runDayEventsFetch(day: DayKind): Promise<void> {
    dayEventsContext = dayEventsReducer(dayEventsContext, { type: 'START', day })
    await showScreen('dayLoading', screens.dayLoadingScreenText(day))

    // showScreen()の描画待ちの間に何らかの理由で状態が変わっていないか再確認してから送信する。
    if (dayEventsContext.state !== 'loading') return

    const requestId = createRequestId()
    const controller = new AbortController()
    dayEventsAbortController = controller

    logSafe({ event: 'day_events_started' })

    const outcome = await withProductAuthRetry(
      (auth) => ({
        day,
        baseUrl,
        sessionToken: auth.sessionToken,
        installId: auth.installId,
        requestId,
        signal: controller.signal,
        timeoutMs: dayEventsTimeoutMs,
        locale: getActiveLocale(),
      }),
      fetchDayEventsFn,
    )

    if (dayEventsContext.state !== 'loading' || dayEventsAbortController !== controller) {
      return
    }
    dayEventsAbortController = null

    if (outcome.kind === 'aborted') {
      return
    }

    if (outcome.kind !== 'success') {
      const errorCode: ErrorCode =
        outcome.kind === 'auth_failed'
          ? 'day_events_auth_failed'
          : outcome.kind === 'forbidden'
            ? 'day_events_forbidden'
            : outcome.kind === 'rate_limited'
              ? 'day_events_rate_limited'
              : outcome.kind === 'timeout'
                ? 'day_events_timeout'
                : outcome.kind === 'network_error'
                  ? 'day_events_network_error'
                  : 'day_events_failed'
      dayEventsContext = dayEventsReducer(dayEventsContext, { type: 'FAILED', errorCode })
      logSafe({ event: 'day_events_failed', errorCode })
      await showScreen('dayError', screens.dayErrorScreenText(errorMessage(errorCode)))
      return
    }

    const sortedEvents = sortEventsForDisplay(outcome.result.events)
    dayEventsContext = dayEventsReducer(dayEventsContext, {
      type: 'SUCCEEDED',
      dateLocal: outcome.result.dateLocal,
      events: sortedEvents,
      truncated: outcome.result.truncated,
    })
    logSafe({ event: 'day_events_succeeded', resultCount: sortedEvents.length })

    if (dayEventsContext.state === 'empty') {
      await showScreen('dayEmpty', screens.dayEmptyScreenText(day))
      return
    }

    await renderDayList()
  }

  /** dayLoading画面の二度押しでのみ呼ばれる。中止後は新ホームへ戻る。 */
  async function cancelDayEvents(): Promise<void> {
    if (dayEventsContext.state !== 'loading') return
    dayEventsAbortController?.abort()
    dayEventsAbortController = null
    dayEventsContext = dayEventsReducer(dayEventsContext, { type: 'RESET' })
    logSafe({ event: 'day_events_cancelled' })
    await goHome()
  }

  async function moveDayEventsSelectionUp(): Promise<void> {
    if (dayEventsContext.state !== 'loaded') return
    dayEventsContext = dayEventsReducer(dayEventsContext, { type: 'SELECT_UP' })
    await renderDayList()
  }

  async function moveDayEventsSelectionDown(): Promise<void> {
    if (dayEventsContext.state !== 'loaded') return
    dayEventsContext = dayEventsReducer(dayEventsContext, { type: 'SELECT_DOWN' })
    await renderDayList()
  }

  /** dayList画面の単押しでのみ呼ばれる。現在選択中の予定の詳細を取得する。 */
  async function selectEventFromDayList(): Promise<void> {
    if (currentScreen !== 'dayList' || dayEventsContext.state !== 'loaded' || dayEventsContext.day === null) return
    const event = dayEventsContext.events[dayEventsContext.selectedIndex]
    if (!event) return
    await openEventDetail(event.eventId, dayEventsContext.day)
  }

  /** ホームメニューと同じ3件ウィンドウの選択カーソルで表示する(旧: 3件区切りのページ送り)。 */
  function upcomingListScreenText(): string {
    if (upcomingEventsContext.state !== 'loaded') return ''
    const total = upcomingEventsContext.events.length
    const selectedIndex = upcomingEventsContext.selectedIndex
    const start = screens.windowStart(selectedIndex, total, UPCOMING_EVENTS_PER_PAGE)
    const windowItems = upcomingEventsContext.events.slice(start, start + UPCOMING_EVENTS_PER_PAGE)
    const referenceYear = Number(nowLocalIsoTokyo().slice(0, 4))
    const lines = windowItems.map((event, i) => {
      const formatted = formatUpcomingEventLine(event, referenceYear)
      return start + i === selectedIndex ? `> ${formatted}` : `  ${formatted}`
    })
    const isLastWindow = start + windowItems.length >= total
    return screens.upcomingEventsScreenText(selectedIndex, total, lines, isLastWindow, upcomingEventsContext.truncated)
  }

  async function renderUpcomingList(): Promise<void> {
    await showScreen('upcomingList', upcomingListScreenText())
  }

  /** ホーム画面の「直近5件の予定」の単押しでのみ呼ばれる。二重送信防止のため、直前がhome画面の時だけ受け付ける。 */
  async function startUpcomingEvents(): Promise<void> {
    if (currentScreen !== 'home') return
    await runUpcomingEventsFetch()
  }

  /** 実際のfetchロジック本体。runDayEventsFetch()と同じ理由でstartUpcomingEvents()のガードとは分離してある。 */
  async function runUpcomingEventsFetch(): Promise<void> {
    upcomingEventsContext = upcomingEventsReducer(upcomingEventsContext, { type: 'START' })
    await showScreen('upcomingLoading', screens.upcomingLoadingScreenText())

    // showScreen()の描画待ちの間に何らかの理由で状態が変わっていないか再確認してから送信する。
    if (upcomingEventsContext.state !== 'loading') return

    const requestId = createRequestId()
    const controller = new AbortController()
    upcomingEventsAbortController = controller

    logSafe({ event: 'upcoming_events_started' })

    const outcome = await withProductAuthRetry(
      (auth) => ({
        limit: UPCOMING_EVENTS_LIMIT,
        baseUrl,
        sessionToken: auth.sessionToken,
        installId: auth.installId,
        requestId,
        signal: controller.signal,
        timeoutMs: upcomingEventsTimeoutMs,
        locale: getActiveLocale(),
      }),
      fetchUpcomingEventsFn,
    )

    if (upcomingEventsContext.state !== 'loading' || upcomingEventsAbortController !== controller) {
      return
    }
    upcomingEventsAbortController = null

    if (outcome.kind === 'aborted') {
      return
    }

    if (outcome.kind !== 'success') {
      const errorCode: ErrorCode =
        outcome.kind === 'auth_failed'
          ? 'day_events_auth_failed'
          : outcome.kind === 'forbidden'
            ? 'day_events_forbidden'
            : outcome.kind === 'rate_limited'
              ? 'day_events_rate_limited'
              : outcome.kind === 'timeout'
                ? 'day_events_timeout'
                : outcome.kind === 'network_error'
                  ? 'day_events_network_error'
                  : 'day_events_failed'
      upcomingEventsContext = upcomingEventsReducer(upcomingEventsContext, { type: 'FAILED', errorCode })
      logSafe({ event: 'upcoming_events_failed', errorCode })
      await showScreen('upcomingError', screens.dayErrorScreenText(errorMessage(errorCode)))
      return
    }

    upcomingEventsContext = upcomingEventsReducer(upcomingEventsContext, {
      type: 'SUCCEEDED',
      events: outcome.result.events,
      truncated: outcome.result.truncated,
    })
    logSafe({ event: 'upcoming_events_succeeded', resultCount: outcome.result.events.length })

    if (upcomingEventsContext.state === 'empty') {
      await showScreen('upcomingEmpty', screens.upcomingEmptyScreenText())
      return
    }

    await renderUpcomingList()
  }

  /** upcomingLoading画面の二度押しでのみ呼ばれる。中止後は新ホームへ戻る。 */
  async function cancelUpcomingEvents(): Promise<void> {
    if (upcomingEventsContext.state !== 'loading') return
    upcomingEventsAbortController?.abort()
    upcomingEventsAbortController = null
    upcomingEventsContext = upcomingEventsReducer(upcomingEventsContext, { type: 'RESET' })
    logSafe({ event: 'upcoming_events_cancelled' })
    await goHome()
  }

  async function moveUpcomingEventsSelectionUp(): Promise<void> {
    if (upcomingEventsContext.state !== 'loaded') return
    upcomingEventsContext = upcomingEventsReducer(upcomingEventsContext, { type: 'SELECT_UP' })
    await renderUpcomingList()
  }

  async function moveUpcomingEventsSelectionDown(): Promise<void> {
    if (upcomingEventsContext.state !== 'loaded') return
    upcomingEventsContext = upcomingEventsReducer(upcomingEventsContext, { type: 'SELECT_DOWN' })
    await renderUpcomingList()
  }

  /** upcomingList画面の単押しでのみ呼ばれる。現在選択中の予定の詳細を取得する。 */
  async function selectEventFromUpcomingList(): Promise<void> {
    if (currentScreen !== 'upcomingList' || upcomingEventsContext.state !== 'loaded') return
    const event = upcomingEventsContext.events[upcomingEventsContext.selectedIndex]
    if (!event) return
    await openEventDetail(event.eventId, 'upcoming')
  }

  // --- Phase 2I: 予定詳細/編集/削除フロー ---

  /** リストから選ばれた予定の詳細(GET /plugin/calendar-events/:eventId)を取得する。 */
  async function openEventDetail(eventId: string, origin: EventListOrigin): Promise<void> {
    selectedEventId = eventId
    selectedEventOrigin = origin
    eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'START' })
    await showScreen('eventDetailLoading', screens.eventDetailLoadingScreenText())
    if (eventDetailContext.state !== 'loading') return

    const requestId = createRequestId()
    const controller = new AbortController()
    eventDetailAbortController = controller

    logSafe({ event: 'event_detail_started' })

    const outcome = await withProductAuthRetry(
      (auth) => ({
        eventId,
        baseUrl,
        sessionToken: auth.sessionToken,
        installId: auth.installId,
        requestId,
        signal: controller.signal,
        timeoutMs: dayEventsTimeoutMs,
        locale: getActiveLocale(),
      }),
      fetchEventDetailFn,
    )

    if (eventDetailContext.state !== 'loading' || eventDetailAbortController !== controller) return
    eventDetailAbortController = null
    if (outcome.kind === 'aborted') return

    if (outcome.kind === 'not_found') {
      eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'FAILED', errorKind: 'not_found' })
      logSafe({ event: 'event_detail_failed', errorCode: 'not_found' })
      await showScreen('eventGone', screens.eventGoneScreenText())
      return
    }

    if (outcome.kind !== 'success') {
      const errorCode = eventDetailErrorCode(outcome.kind)
      eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'FAILED', errorKind: 'transient' })
      logSafe({ event: 'event_detail_failed', errorCode })
      await showScreen('eventDetailError', screens.eventDetailErrorScreenText(errorMessage(errorCode)))
      return
    }

    eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'SUCCEEDED', detail: outcome.result })
    logSafe({ event: 'event_detail_succeeded' })
    await renderEventDetail()
  }

  function eventDetailErrorCode(kind: Exclude<FetchEventDetailOutcome['kind'], 'success' | 'aborted' | 'not_found'>): ErrorCode {
    switch (kind) {
      case 'auth_failed':
        return 'event_detail_auth_failed'
      case 'forbidden':
        return 'event_detail_forbidden'
      case 'rate_limited':
        return 'event_detail_rate_limited'
      case 'timeout':
        return 'event_detail_timeout'
      case 'network_error':
        return 'event_detail_network_error'
      default:
        return 'event_detail_failed'
    }
  }

  function eventDetailScreenTextFor(): string {
    if (eventDetailContext.state !== 'loaded' || !eventDetailContext.detail) return ''
    const detail = eventDetailContext.detail
    const allLines = buildEventDetailLines(detail)
    const pageCount = eventDetailPageCount(allLines.length)
    const start = eventDetailContext.page * EVENT_DETAIL_LINES_PER_PAGE
    const pageLines = allLines.slice(start, start + EVENT_DETAIL_LINES_PER_PAGE)
    return screens.eventDetailScreenText(detail.title, eventDetailContext.page, pageCount, pageLines)
  }

  async function renderEventDetail(): Promise<void> {
    await showScreen('eventDetail', eventDetailScreenTextFor())
  }

  async function pageEventDetailUp(): Promise<void> {
    if (eventDetailContext.state !== 'loaded' || !eventDetailContext.detail) return
    const pageCount = eventDetailPageCount(buildEventDetailLines(eventDetailContext.detail).length)
    eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'PAGE_UP', pageCount })
    await renderEventDetail()
  }

  async function pageEventDetailDown(): Promise<void> {
    if (eventDetailContext.state !== 'loaded' || !eventDetailContext.detail) return
    const pageCount = eventDetailPageCount(buildEventDetailLines(eventDetailContext.detail).length)
    eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'PAGE_DOWN', pageCount })
    await renderEventDetail()
  }

  /** eventDetailError画面の単押しでのみ呼ばれる。同じeventIdで取得し直す。 */
  async function retryEventDetail(): Promise<void> {
    if (currentScreen !== 'eventDetailError' || selectedEventId === null || selectedEventOrigin === null) return
    await openEventDetail(selectedEventId, selectedEventOrigin)
  }

  /** eventDetailLoading画面の二度押しでのみ呼ばれる。取得を中止して元の一覧位置へ戻る(再取得はしない)。 */
  async function cancelEventDetailLoad(): Promise<void> {
    if (eventDetailContext.state !== 'loading') return
    eventDetailAbortController?.abort()
    eventDetailAbortController = null
    eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'RESET' })
    logSafe({ event: 'event_detail_cancelled' })
    await backToOriginList()
  }

  /** 何も変わっていない一覧へ戻る(位置は一覧側のcontextにそのまま残っているため再取得しない)。 */
  async function backToOriginList(): Promise<void> {
    const origin = selectedEventOrigin
    selectedEventId = null
    selectedEventOrigin = null
    eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'RESET' })
    if (origin === 'upcoming') {
      await renderUpcomingList()
    } else if (origin === 'today' || origin === 'tomorrow') {
      await renderDayList()
    } else {
      await goHome()
    }
  }

  /**
   * 削除成功後、または予定が他端末で更新・削除されていた場合(eventGone)に、元の一覧を
   * 「キャッシュを使い回さず」再取得して戻る。dayList/upcomingListいずれも読み込み失敗時は
   * 既存のdayError/upcomingError画面へ自然に遷移する(この関数はガード無しの内部fetchを直接呼ぶ)。
   */
  async function returnToFreshOriginList(): Promise<void> {
    const origin = selectedEventOrigin
    selectedEventId = null
    selectedEventOrigin = null
    eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'RESET' })
    if (origin === 'today' || origin === 'tomorrow') {
      await runDayEventsFetch(origin)
    } else if (origin === 'upcoming') {
      await runUpcomingEventsFetch()
    } else {
      await goHome()
    }
  }

  async function openEventDetailMenu(): Promise<void> {
    if (currentScreen !== 'eventDetail' || eventDetailContext.state !== 'loaded') return
    eventDetailMenuIndex = 0
    await showScreen('eventDetailMenu', screens.eventDetailMenuScreenText(eventDetailMenuIndex))
  }

  async function closeEventDetailMenu(): Promise<void> {
    if (currentScreen !== 'eventDetailMenu') return
    await renderEventDetail()
  }

  async function moveEventDetailMenuUp(): Promise<void> {
    if (currentScreen !== 'eventDetailMenu') return
    eventDetailMenuIndex = Math.max(0, eventDetailMenuIndex - 1)
    await showScreen('eventDetailMenu', screens.eventDetailMenuScreenText(eventDetailMenuIndex))
  }

  async function moveEventDetailMenuDown(): Promise<void> {
    if (currentScreen !== 'eventDetailMenu') return
    eventDetailMenuIndex = Math.min(screens.EVENT_DETAIL_MENU_ITEMS.length - 1, eventDetailMenuIndex + 1)
    await showScreen('eventDetailMenu', screens.eventDetailMenuScreenText(eventDetailMenuIndex))
  }

  async function selectEventDetailMenuItem(): Promise<void> {
    if (currentScreen !== 'eventDetailMenu') return
    if (eventDetailMenuIndex === 0) {
      await beginEditRecording()
    } else if (eventDetailMenuIndex === 1) {
      await showDeleteConfirm()
    } else {
      await backToOriginList()
    }
  }

  // --- 削除フロー ---

  async function showDeleteConfirm(): Promise<void> {
    if (eventDetailContext.state !== 'loaded' || !eventDetailContext.detail) return
    const detail = eventDetailContext.detail
    await showScreen('deleteConfirm', screens.deleteConfirmScreenText(detail.title, formatEventDetailWhen(detail) ?? ''))
  }

  /** deleteConfirm画面の二度押し(キャンセル)でのみ呼ばれる。DELETEは一切呼ばない。 */
  async function cancelDeleteConfirm(): Promise<void> {
    if (currentScreen !== 'deleteConfirm') return
    await renderEventDetail()
  }

  /** deleteConfirm画面の単押し(削除する)でのみ呼ばれる。ユーザーの明示操作なので新しいidempotencyKeyを発行する。 */
  async function confirmDelete(): Promise<void> {
    if (currentScreen !== 'deleteConfirm' || selectedEventId === null) return
    currentMutationIdempotencyKey = createRequestId()
    await runDelete()
  }

  /** deleteError画面の単押し(再試行)でのみ呼ばれる。同一ユーザー操作の再試行のため、同じidempotencyKeyを使い回す。 */
  async function retryDelete(): Promise<void> {
    if (currentScreen !== 'deleteError' || selectedEventId === null || currentMutationIdempotencyKey === null) return
    await runDelete()
  }

  async function runDelete(): Promise<void> {
    if (selectedEventId === null || currentMutationIdempotencyKey === null) return
    const eventId = selectedEventId
    const idempotencyKey = currentMutationIdempotencyKey

    deleteMutationContext = eventMutationReducer(deleteMutationContext, { type: 'START' })
    await showScreen('deleting', screens.deletingScreenText())
    if (deleteMutationContext.state !== 'inProgress') return

    const requestId = createRequestId()
    const controller = new AbortController()
    deleteAbortController = controller

    logSafe({ event: 'event_delete_started' })

    const outcome = await withProductAuthRetry(
      (auth) => ({
        eventId,
        idempotencyKey,
        baseUrl,
        sessionToken: auth.sessionToken,
        installId: auth.installId,
        requestId,
        signal: controller.signal,
        timeoutMs: registrationTimeoutMs,
      }),
      deleteCalendarEventDetailFn,
    )

    if (deleteMutationContext.state !== 'inProgress' || deleteAbortController !== controller) return
    deleteAbortController = null
    if (outcome.kind === 'aborted') return

    if (outcome.kind === 'success') {
      currentMutationIdempotencyKey = null
      deleteMutationContext = eventMutationReducer(deleteMutationContext, { type: 'RESET' })
      logSafe({ event: 'event_delete_succeeded' })
      // 「一覧に戻ってローカルで消すだけ」ではなく、必ずサーバーから再取得したものを表示する(仕様どおり)。
      await returnToFreshOriginList()
      return
    }

    if (outcome.kind === 'conflict') {
      currentMutationIdempotencyKey = null
      deleteMutationContext = eventMutationReducer(deleteMutationContext, { type: 'RESET' })
      logSafe({ event: 'event_delete_failed', errorCode: 'conflict' })
      await showScreen('eventGone', screens.eventGoneScreenText())
      return
    }

    const errorCode = eventMutationErrorCode(outcome.kind)
    deleteMutationContext = eventMutationReducer(deleteMutationContext, { type: 'FAILED', errorKind: 'transient' })
    logSafe({ event: 'event_delete_failed', errorCode })
    await showScreen('deleteError', screens.eventMutationErrorScreenText(errorMessage(errorCode)))
  }

  function eventMutationErrorCode(kind: 'auth_failed' | 'invalid' | 'rate_limited' | 'not_connected' | 'timeout' | 'network_error' | 'failed'): ErrorCode {
    switch (kind) {
      case 'auth_failed':
        return 'registration_auth_failed'
      case 'invalid':
        return 'event_mutation_invalid'
      case 'rate_limited':
        return 'event_mutation_rate_limited'
      case 'not_connected':
        return 'event_mutation_not_connected'
      case 'timeout':
        return 'event_mutation_timeout'
      case 'network_error':
        return 'event_mutation_network_error'
      default:
        return 'event_mutation_failed'
    }
  }

  // --- 編集フロー(既存の録音+解析パイプラインを再利用する) ---

  async function handleEditAudioEventTimeout(): Promise<void> {
    if (editRecordingContext.state !== 'recording') return
    clearWatchdog()
    clearFirstChunkTimer()
    await stopMicrophone()
    editBuffer.clear()
    editRecordingContext = recordingReducer(editRecordingContext, { type: 'ERROR', errorCode: 'audio_event_timeout' })
    logSafe({ event: 'edit_audio_event_timeout', state: editRecordingContext.state })
    await showScreen('error', screens.errorScreenText(errorMessage('audio_event_timeout')))
  }

  /** eventDetailMenuで「編集」を選んだとき、またはeditNotUnderstood画面の単押し(録音し直す)から呼ばれる。 */
  async function beginEditRecording(): Promise<void> {
    if (currentScreen !== 'eventDetailMenu' && currentScreen !== 'editNotUnderstood') return
    editRecordingContext = recordingReducer(editRecordingContext, { type: 'START' })
    editBuffer.clear()
    receivedFirstChunk = false

    let started = false
    try {
      started = await bridge.audioControl(true, AudioInputSource.Glasses)
    } catch {
      started = false
    }

    if (!started) {
      editRecordingContext = recordingReducer(editRecordingContext, { type: 'START_FAILED', errorCode: 'audio_start_failed' })
      logSafe({ event: 'edit_audio_start_failed', state: editRecordingContext.state, startResult: false })
      await showScreen('error', screens.errorScreenText(errorMessage('audio_start_failed')))
      return
    }

    micOpen = true
    editRecordingContext = recordingReducer(editRecordingContext, { type: 'STARTED' })
    logSafe({ event: 'edit_recording_started', state: editRecordingContext.state, startResult: true })
    await showScreen('editRecording', screens.editRecordingScreenText())

    clearWatchdog()
    watchdogTimer = setTimeout(() => {
      void finishEditRecording()
    }, MAX_RECORDING_SECONDS * 1000)

    clearFirstChunkTimer()
    firstChunkTimer = setTimeout(() => {
      if (!receivedFirstChunk) {
        void handleEditAudioEventTimeout()
      }
    }, FIRST_CHUNK_TIMEOUT_MS)
  }

  async function finishEditRecording(): Promise<void> {
    if (editRecordingContext.state !== 'recording') return
    clearWatchdog()
    clearFirstChunkTimer()
    editRecordingContext = recordingReducer(editRecordingContext, { type: 'STOP' })

    const stopOk = await stopMicrophone()
    logSafe({
      event: 'edit_audio_stop',
      state: editRecordingContext.state,
      stopResult: stopOk,
      chunkCount: editBuffer.chunkCount,
      totalBytes: editBuffer.byteLength,
      seconds: editBuffer.seconds,
    })

    if (!stopOk) {
      editRecordingContext = recordingReducer(editRecordingContext, { type: 'STOP_FAILED', errorCode: 'audio_stop_failed' })
      editBuffer.clear()
      await showScreen('error', screens.errorScreenText(errorMessage('audio_stop_failed')))
      return
    }

    try {
      const seconds = editBuffer.seconds
      if (seconds < MIN_RECORDING_SECONDS) {
        editBuffer.clear()
        editRecordingContext = recordingReducer(editRecordingContext, { type: 'RESET' })
        await showScreen('tooShort', screens.tooShortScreenText())
        return
      }

      editRecordingContext = recordingReducer(editRecordingContext, { type: 'STOPPED', durationSec: seconds })
      await showScreen('editCaptured', screens.editCapturedScreenText(seconds))
    } catch {
      editBuffer.clear()
      editRecordingContext = recordingReducer(editRecordingContext, { type: 'STOP_FAILED', errorCode: 'audio_processing_failed' })
      await showScreen('error', screens.errorScreenText(errorMessage('audio_processing_failed')))
    }
  }

  /** editRecording画面の二度押しでのみ呼ばれる。初回録音・追加入力と同様、中止後はホームへ戻る(既存の慣習を踏襲)。 */
  async function cancelEditRecording(): Promise<void> {
    if (editRecordingContext.state !== 'recording') return
    clearWatchdog()
    clearFirstChunkTimer()
    editRecordingContext = recordingReducer(editRecordingContext, { type: 'CANCEL' })
    await stopMicrophone()
    editBuffer.clear()
    editRecordingContext = recordingReducer(editRecordingContext, { type: 'CANCELLED' })
    logSafe({ event: 'edit_recording_cancelled', state: editRecordingContext.state })
    await goHome()
  }

  /** editCaptured画面の単押し(確認へ)でのみ呼ばれる。 */
  async function startEditAnalysis(): Promise<void> {
    if (editRecordingContext.state !== 'captured' || editAnalysisContext.state === 'analyzing' || selectedEventId === null) return

    editAnalysisContext = editAnalysisReducer(editAnalysisContext, { type: 'START' })
    await showScreen('editAnalyzing', screens.editAnalyzingScreenText())
    if (editAnalysisContext.state !== 'analyzing') return

    let wav: Uint8Array
    let requestId: string
    try {
      const pcm = editBuffer.concat()
      editBuffer.clear()
      wav = encodeWav(pcm)
      requestId = createRequestId()
    } catch {
      editAnalysisContext = editAnalysisReducer(editAnalysisContext, { type: 'FAILED', errorCode: 'edit_analysis_failed' })
      logSafe({ event: 'analyze_edit_audio_failed', errorCode: 'edit_analysis_failed' })
      await showScreen('error', screens.errorScreenText(errorMessage('edit_analysis_failed')))
      return
    }

    const controller = new AbortController()
    editAnalysisAbortController = controller
    const eventId = selectedEventId

    logSafe({ event: 'analyze_edit_audio_started', wavBytes: wav.byteLength })

    const outcome = await withProductAuthRetry(
      (auth) => ({
        wav,
        eventId,
        baseUrl,
        sessionToken: auth.sessionToken,
        installId: auth.installId,
        requestId,
        signal: controller.signal,
        timeoutMs: analysisTimeoutMs,
        locale: getActiveLocale(),
      }),
      analyzeEditAudioFn,
    )

    if (editAnalysisContext.state !== 'analyzing' || editAnalysisAbortController !== controller) return
    editAnalysisAbortController = null
    if (outcome.kind === 'aborted') return

    if (outcome.kind !== 'success') {
      const errorCode: ErrorCode =
        outcome.kind === 'auth_failed'
          ? 'analysis_auth_failed'
          : outcome.kind === 'timeout'
            ? 'edit_analysis_timeout'
            : outcome.kind === 'rate_limited'
              ? 'edit_analysis_rate_limited'
              : outcome.kind === 'network_error'
                ? 'edit_analysis_network_error'
                : 'edit_analysis_failed'
      editAnalysisContext = editAnalysisReducer(editAnalysisContext, { type: 'FAILED', errorCode })
      logSafe({ event: 'analyze_edit_audio_failed', errorCode })
      await showScreen('error', screens.errorScreenText(errorMessage(errorCode)))
      return
    }

    const result = outcome.result
    logSafe({ event: 'analyze_edit_audio_succeeded', resultType: result.resultType })

    if (result.resultType === 'not_understood') {
      editAnalysisContext = editAnalysisReducer(editAnalysisContext, { type: 'SUCCEEDED', result })
      await showScreen('editNotUnderstood', screens.editNotUnderstoodScreenText())
      return
    }

    const currentDetail = eventDetailContext.detail
    if (!currentDetail || !validateEditInstructionTiming(currentDetail, result.fields)) {
      editAnalysisContext = editAnalysisReducer(editAnalysisContext, { type: 'FAILED', errorCode: 'edit_analysis_invalid_timing' })
      logSafe({ event: 'analyze_edit_audio_failed', errorCode: 'edit_analysis_invalid_timing' })
      await showScreen('error', screens.errorScreenText(errorMessage('edit_analysis_invalid_timing')))
      return
    }

    const diff = computeEditDiff(currentDetail, result.fields)
    if (diff.length === 0) {
      // 指示されたフィールドが現在値と同じ(実質的な変更なし)。PATCHは送らず詳細画面へ戻す。
      editAnalysisContext = editAnalysisReducer(editAnalysisContext, { type: 'RESET' })
      editRecordingContext = recordingReducer(editRecordingContext, { type: 'RESET' })
      await renderEventDetail()
      return
    }

    pendingEditFields = fieldsForDiff(result.fields, diff)
    editAnalysisContext = editAnalysisReducer(editAnalysisContext, { type: 'SUCCEEDED', result })
    await showScreen('editConfirm', screens.editConfirmScreenText(diff))
  }

  /** editAnalyzing画面の二度押しでのみ呼ばれる。既存のanalyzing画面と同様、中止後はホームへ戻る。 */
  async function cancelEditAnalysis(): Promise<void> {
    if (editAnalysisContext.state !== 'analyzing') return
    editAnalysisAbortController?.abort()
    editAnalysisAbortController = null
    editAnalysisContext = editAnalysisReducer(editAnalysisContext, { type: 'CANCELLED' })
    logSafe({ event: 'analyze_edit_audio_cancelled', state: editAnalysisContext.state })
    await goHome()
  }

  /** editConfirm画面の二度押し(キャンセル)でのみ呼ばれる。PATCHは一切呼ばず、音声バッファも解放して詳細画面へ戻る。 */
  async function cancelEditConfirm(): Promise<void> {
    if (currentScreen !== 'editConfirm') return
    pendingEditFields = {}
    editAnalysisContext = editAnalysisReducer(editAnalysisContext, { type: 'RESET' })
    editRecordingContext = recordingReducer(editRecordingContext, { type: 'RESET' })
    editBuffer.clear()
    await renderEventDetail()
  }

  /** editConfirm画面の単押し(更新する)でのみ呼ばれる。ユーザーの明示操作なので新しいidempotencyKeyを発行する。 */
  async function confirmEditApply(): Promise<void> {
    if (currentScreen !== 'editConfirm' || selectedEventId === null) return
    currentMutationIdempotencyKey = createRequestId()
    await runEditApply()
  }

  /** editError画面の単押し(再試行)でのみ呼ばれる。同一ユーザー操作の再試行のため、同じidempotencyKeyを使い回す。 */
  async function retryEditApply(): Promise<void> {
    if (currentScreen !== 'editError' || selectedEventId === null || currentMutationIdempotencyKey === null) return
    await runEditApply()
  }

  async function runEditApply(): Promise<void> {
    if (selectedEventId === null || currentMutationIdempotencyKey === null) return
    const eventId = selectedEventId
    const idempotencyKey = currentMutationIdempotencyKey
    const fields = pendingEditFields

    editApplyContext = eventMutationReducer(editApplyContext, { type: 'START' })
    await showScreen('editApplying', screens.editApplyingScreenText())
    if (editApplyContext.state !== 'inProgress') return

    const requestId = createRequestId()
    const controller = new AbortController()
    editApplyAbortController = controller

    logSafe({ event: 'event_update_started' })

    const outcome = await withProductAuthRetry(
      (auth) => ({
        eventId,
        idempotencyKey,
        fields,
        baseUrl,
        sessionToken: auth.sessionToken,
        installId: auth.installId,
        requestId,
        signal: controller.signal,
        timeoutMs: registrationTimeoutMs,
      }),
      updateCalendarEventDetailFn,
    )

    if (editApplyContext.state !== 'inProgress' || editApplyAbortController !== controller) return
    editApplyAbortController = null
    if (outcome.kind === 'aborted') return

    if (outcome.kind === 'success') {
      currentMutationIdempotencyKey = null
      pendingEditFields = {}
      editApplyContext = eventMutationReducer(editApplyContext, { type: 'RESET' })
      editAnalysisContext = editAnalysisReducer(editAnalysisContext, { type: 'RESET' })
      editRecordingContext = recordingReducer(editRecordingContext, { type: 'RESET' })
      logSafe({ event: 'event_update_succeeded' })
      await refetchDetailAfterMutation()
      return
    }

    if (outcome.kind === 'conflict' || outcome.kind === 'not_found') {
      currentMutationIdempotencyKey = null
      pendingEditFields = {}
      editApplyContext = eventMutationReducer(editApplyContext, { type: 'RESET' })
      logSafe({ event: 'event_update_failed', errorCode: 'conflict' })
      await showScreen('eventGone', screens.eventGoneScreenText())
      return
    }

    const errorCode = eventMutationErrorCode(outcome.kind)
    editApplyContext = eventMutationReducer(editApplyContext, { type: 'FAILED', errorKind: 'transient' })
    logSafe({ event: 'event_update_failed', errorCode })
    await showScreen('editError', screens.eventMutationErrorScreenText(errorMessage(errorCode)))
  }

  /**
   * PATCH成功直後にGETで最新状態を取り直して詳細画面を再表示する(仕様どおり)。この再取得自体が
   * 失敗しても「更新は成功している」ことを偽らず、eventDetailError(再試行/一覧へ戻る)を素直に見せる。
   */
  async function refetchDetailAfterMutation(): Promise<void> {
    if (selectedEventId === null) return
    const eventId = selectedEventId
    eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'START' })
    await showScreen('eventDetailLoading', screens.eventDetailLoadingScreenText())
    if (eventDetailContext.state !== 'loading') return

    const requestId = createRequestId()
    const controller = new AbortController()
    eventDetailAbortController = controller

    const outcome = await withProductAuthRetry(
      (auth) => ({
        eventId,
        baseUrl,
        sessionToken: auth.sessionToken,
        installId: auth.installId,
        requestId,
        signal: controller.signal,
        timeoutMs: dayEventsTimeoutMs,
        locale: getActiveLocale(),
      }),
      fetchEventDetailFn,
    )

    if (eventDetailContext.state !== 'loading' || eventDetailAbortController !== controller) return
    eventDetailAbortController = null
    if (outcome.kind === 'aborted') return

    if (outcome.kind === 'not_found') {
      eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'FAILED', errorKind: 'not_found' })
      await showScreen('eventGone', screens.eventGoneScreenText())
      return
    }

    if (outcome.kind !== 'success') {
      const errorCode = eventDetailErrorCode(outcome.kind)
      eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'FAILED', errorKind: 'transient' })
      logSafe({ event: 'event_detail_failed', errorCode })
      await showScreen('eventDetailError', screens.eventDetailErrorScreenText(errorMessage(errorCode)))
      return
    }

    eventDetailContext = eventDetailReducer(eventDetailContext, { type: 'SUCCEEDED', detail: outcome.result })
    await renderEventDetail()
  }

  // --- Phase 2H: 製品用ペアリングフロー(製品モードのみで使用) ---

  async function showNotConnectedScreen(): Promise<void> {
    clearPairingPollTimer()
    pairingAbortController?.abort()
    pairingAbortController = null
    pairingContext = pairingReducer(pairingContext, { type: 'RESET' })
    await showScreen('notConnected', screens.notConnectedScreenText())
  }

  function schedulePairingPoll(pollIntervalSeconds: number): void {
    clearPairingPollTimer()
    pairingPollTimer = setTimeout(() => {
      void pollPairingOnce(pollIntervalSeconds)
    }, pollIntervalSeconds * 1000)
  }

  async function exchangeAfterApproval(): Promise<void> {
    if (pairingContext.pairingId === null) return
    const pairingId = pairingContext.pairingId
    pairingContext = pairingReducer(pairingContext, { type: 'APPROVED' })

    const controller = new AbortController()
    pairingAbortController = controller
    const outcome = await exchangePairingFn({
      baseUrl,
      pairingId,
      installationId: productInstallationId,
      signal: controller.signal,
    })
    if (pairingContext.state !== 'exchanging' || pairingAbortController !== controller) return
    pairingAbortController = null

    if (outcome.kind !== 'success') {
      pairingContext = pairingReducer(pairingContext, { type: 'COMMUNICATION_FAILED' })
      logSafe({ event: 'product_pairing_exchange_failed' })
      await showScreen('pairingError', screens.pairingErrorScreenText('communication_failure'))
      return
    }

    if (tokenStore) {
      await tokenStore.save({
        refreshToken: outcome.refreshToken,
        refreshTokenExpiresAt: outcome.refreshTokenExpiresAt,
      })
    }
    // access tokenはTokenStore(永続化)には保存せず、ProductAuthManagerのメモリ上にのみ反映する。
    authManager?.primeAccessToken(outcome.accessToken, outcome.accessTokenExpiresInSeconds)
    pairingContext = pairingReducer(pairingContext, { type: 'EXCHANGE_SUCCEEDED' })
    logSafe({ event: 'product_pairing_exchange_succeeded' })
    await showScreen('pairingSuccess', screens.pairingSuccessScreenText())
  }

  async function pollPairingOnce(pollIntervalSeconds: number): Promise<void> {
    if (pairingContext.state !== 'waitingApproval' || pairingContext.pairingId === null) return

    if (pairingStartedAt !== null && Date.now() - pairingStartedAt >= pairingPollMaxDurationMs) {
      pairingContext = pairingReducer(pairingContext, { type: 'EXPIRED' })
      logSafe({ event: 'product_pairing_poll_expired' })
      await showScreen('pairingError', screens.pairingErrorScreenText('expired'))
      return
    }

    const controller = new AbortController()
    pairingAbortController = controller
    const outcome = await checkPairingStatusFn({
      baseUrl,
      pairingId: pairingContext.pairingId,
      installationId: productInstallationId,
      signal: controller.signal,
    })
    if (pairingContext.state !== 'waitingApproval' || pairingAbortController !== controller) return
    pairingAbortController = null

    if (outcome.kind !== 'success') {
      // 単発の通信失敗では即エラーにせず、次回ポーリングでリトライする。
      schedulePairingPoll(pollIntervalSeconds)
      return
    }

    switch (outcome.status) {
      case 'pending':
      case 'oauth_in_progress':
        schedulePairingPoll(pollIntervalSeconds)
        return
      case 'approved':
        await exchangeAfterApproval()
        return
      case 'expired':
        pairingContext = pairingReducer(pairingContext, { type: 'EXPIRED' })
        await showScreen('pairingError', screens.pairingErrorScreenText('expired'))
        return
      case 'cancelled':
      case 'exchanged':
        // 'exchanged'はこの端末以外の経路で既に交換済みの場合など、通常発生しない防御的な分岐。
        pairingContext = pairingReducer(pairingContext, { type: 'CANCELLED' })
        await showScreen('pairingError', screens.pairingErrorScreenText('cancelled'))
        return
      case 'failed':
        pairingContext = pairingReducer(pairingContext, { type: 'AUTH_FAILED' })
        await showScreen('pairingError', screens.pairingErrorScreenText('auth_failure'))
        return
    }
  }

  /** notConnected/pairingError画面の単押しでのみ呼ばれる。新しいペアリングを開始する。 */
  async function startPairingFlow(): Promise<void> {
    // Phase 2K: notConnected/pairingErrorに加え、homeメニュー5番目(明示的な再接続)からの起動も許可する。
    if (currentScreen !== 'notConnected' && currentScreen !== 'pairingError' && currentScreen !== 'home') return
    pairingContext = pairingReducer(pairingContext, { type: 'START' })
    await showScreen('pairing', screens.pairingScreenText('', ''))
    if (pairingContext.state !== 'starting') return

    const controller = new AbortController()
    pairingAbortController = controller
    logSafe({ event: 'product_pairing_start_requested' })
    const outcome = await startPairingFn({ baseUrl, installationId: productInstallationId, signal: controller.signal })
    if (pairingContext.state !== 'starting' || pairingAbortController !== controller) return
    pairingAbortController = null

    if (outcome.kind !== 'success') {
      pairingContext = pairingReducer(pairingContext, { type: 'START_FAILED' })
      logSafe({ event: 'product_pairing_start_failed' })
      await showScreen('pairingError', screens.pairingErrorScreenText('communication_failure'))
      return
    }

    pairingContext = pairingReducer(pairingContext, {
      type: 'STARTED',
      pairingId: outcome.pairingId,
      verificationUrl: outcome.verificationUrl,
      userCode: outcome.userCode,
      pollIntervalSeconds: outcome.pollIntervalSeconds,
    })
    pairingStartedAt = Date.now()
    logSafe({ event: 'product_pairing_started' })
    await showScreen('pairing', screens.pairingScreenText(outcome.verificationUrl, outcome.userCode))
    schedulePairingPoll(outcome.pollIntervalSeconds)
  }

  /** pairing画面の二度押しでのみ呼ばれる。ユーザー自身の明示的な中止であり、エラー画面は経由しない。 */
  async function cancelPairingFlow(): Promise<void> {
    if (pairingContext.state !== 'waitingApproval' && pairingContext.state !== 'starting') return
    clearPairingPollTimer()
    pairingAbortController?.abort()
    pairingAbortController = null
    const pairingId = pairingContext.pairingId
    if (pairingId !== null) {
      void cancelPairingFn({ baseUrl, pairingId, installationId: productInstallationId }).catch(() => {})
    }
    pairingContext = pairingReducer(pairingContext, { type: 'RESET' })
    logSafe({ event: 'product_pairing_cancelled' })
    await showScreen('notConnected', screens.notConnectedScreenText())
  }

  async function handlePress(): Promise<void> {
    switch (currentScreen) {
      case 'home':
        if (homeMenuIndex === 0) {
          await beginRecording()
        } else if (homeMenuIndex === 1) {
          await startUpcomingEvents()
        } else if (homeMenuIndex === 2) {
          await startDayEvents('today')
        } else if (homeMenuIndex === 3) {
          await startDayEvents('tomorrow')
        } else {
          // Phase 2K: 5番目(Googleカレンダーを再接続)。既存のペアリングフローをそのまま再利用する。
          await startPairingFlow()
        }
        return
      case 'recording':
        await finishRecording()
        return
      case 'captured':
        await startAnalysis()
        return
      case 'analyzing':
        // 解析中の単押しは無視する(二度押しでのみ中止できる)
        return
      case 'candidate':
        await showFinalConfirm()
        return
      case 'finalConfirm':
        await startRegistration()
        return
      case 'registering':
      case 'checkingStatus':
        // 登録中・結果確認中の単押しは無視する(自動リトライ・二重送信を防ぐため)
        return
      case 'clarification':
        await startFollowupReady()
        return
      case 'followupReady':
        await beginFollowupRecording()
        return
      case 'followupRecording':
        await finishFollowupRecording()
        return
      case 'followupCaptured':
        await startFollowupAnalysis()
        return
      case 'registered':
      case 'tooShort':
      case 'notCalendar':
      case 'error':
        await goHome()
        return
      case 'dayLoading':
      case 'upcomingLoading':
        // 読み込み中の単押しは無視する(二度押しでのみ中止できる)
        return
      case 'dayEmpty':
      case 'dayError':
      case 'upcomingEmpty':
      case 'upcomingError':
        // これらの画面は二度押しでのみホームへ戻る(単押しは無視)
        return
      case 'dayList':
        await selectEventFromDayList()
        return
      case 'upcomingList':
        await selectEventFromUpcomingList()
        return
      case 'eventDetailLoading':
        // 読み込み中の単押しは無視する(二度押しでのみ中止できる)
        return
      case 'eventDetail':
        await openEventDetailMenu()
        return
      case 'eventDetailMenu':
        await selectEventDetailMenuItem()
        return
      case 'eventDetailError':
        await retryEventDetail()
        return
      case 'eventGone':
        await returnToFreshOriginList()
        return
      case 'deleteConfirm':
        await confirmDelete()
        return
      case 'deleting':
        // 削除リクエスト送信中の単押しは無視する
        return
      case 'deleteError':
        await retryDelete()
        return
      case 'editRecording':
        await finishEditRecording()
        return
      case 'editCaptured':
        await startEditAnalysis()
        return
      case 'editAnalyzing':
        // 解析中の単押しは無視する(二度押しでのみ中止できる)
        return
      case 'editNotUnderstood':
        await beginEditRecording()
        return
      case 'editConfirm':
        await confirmEditApply()
        return
      case 'editApplying':
        // 更新リクエスト送信中の単押しは無視する
        return
      case 'editError':
        await retryEditApply()
        return
      case 'notConnected':
        await startPairingFlow()
        return
      case 'pairing':
        // 接続待ち中の単押しは無視する(二度押しでのみ中止できる)
        return
      case 'pairingSuccess':
        await goHome()
        return
      case 'pairingError':
        await showNotConnectedScreen()
        return
    }
  }

  async function handleDoublePress(): Promise<void> {
    switch (currentScreen) {
      case 'home':
        await bridge.shutDownPageContainer(1)
        return
      case 'recording':
        await cancelRecording()
        return
      case 'captured':
        buffer.clear()
        await beginRecording()
        return
      case 'analyzing':
        await cancelAnalysis()
        return
      case 'registering':
      case 'checkingStatus':
        // 登録リクエスト送信後は、クライアント側の中止がサーバー側の登録を止める保証がないため、
        // 二度押しでの中止は受け付けない(結果が確定するまで待つ)。
        return
      case 'followupRecording':
        await cancelFollowupRecording()
        return
      case 'dayLoading':
        await cancelDayEvents()
        return
      case 'upcomingLoading':
        await cancelUpcomingEvents()
        return
      case 'editRecording':
        await cancelEditRecording()
        return
      case 'editAnalyzing':
        await cancelEditAnalysis()
        return
      case 'editApplying':
        // 更新リクエスト送信後は、削除同様クライアント側の中止を保証できないため二度押しでの中止は受け付けない
        return
      case 'deleting':
        // 削除リクエスト送信後は、クライアント側の中止がサーバー側の削除を止める保証がないため受け付けない
        return
      case 'eventDetailLoading':
        await cancelEventDetailLoad()
        return
      case 'eventDetail':
      case 'eventDetailError':
        await backToOriginList()
        return
      case 'eventDetailMenu':
        await closeEventDetailMenu()
        return
      case 'eventGone':
        await returnToFreshOriginList()
        return
      case 'deleteConfirm':
        await cancelDeleteConfirm()
        return
      case 'deleteError':
      case 'editError':
        await returnToFreshOriginList()
        return
      case 'editCaptured':
        await goHome()
        return
      case 'editNotUnderstood':
        await renderEventDetail()
        return
      case 'editConfirm':
        await cancelEditConfirm()
        return
      case 'candidate':
      case 'finalConfirm':
      case 'registered':
      case 'tooShort':
      case 'clarification':
      case 'followupReady':
      case 'followupCaptured':
      case 'notCalendar':
      case 'dayList':
      case 'dayEmpty':
      case 'dayError':
      case 'upcomingList':
      case 'upcomingEmpty':
      case 'upcomingError':
      case 'error':
        await goHome()
        return
      case 'notConnected':
        await bridge.shutDownPageContainer(1)
        return
      case 'pairing':
        await cancelPairingFlow()
        return
      case 'pairingSuccess':
        await goHome()
        return
      case 'pairingError':
        await showNotConnectedScreen()
        return
    }
  }

  async function handleSwipeDown(): Promise<void> {
    if (currentScreen === 'home') {
      homeMenuIndex = Math.min(screens.HOME_MENU_ITEM_COUNT - 1, homeMenuIndex + 1)
      await showScreen('home', screens.homeScreenText(homeMenuIndex))
      return
    }
    if (currentScreen === 'dayList') {
      await moveDayEventsSelectionDown()
      return
    }
    if (currentScreen === 'upcomingList') {
      await moveUpcomingEventsSelectionDown()
      return
    }
    if (currentScreen === 'eventDetail') {
      await pageEventDetailDown()
      return
    }
    if (currentScreen === 'eventDetailMenu') {
      await moveEventDetailMenuDown()
    }
  }

  async function handleSwipeUp(): Promise<void> {
    if (currentScreen === 'home') {
      homeMenuIndex = Math.max(0, homeMenuIndex - 1)
      await showScreen('home', screens.homeScreenText(homeMenuIndex))
      return
    }
    if (currentScreen === 'dayList') {
      await moveDayEventsSelectionUp()
      return
    }
    if (currentScreen === 'upcomingList') {
      await moveUpcomingEventsSelectionUp()
      return
    }
    if (currentScreen === 'eventDetail') {
      await pageEventDetailUp()
      return
    }
    if (currentScreen === 'eventDetailMenu') {
      await moveEventDetailMenuUp()
    }
  }

  function onAudioEvent(pcm: Uint8Array): void {
    // 初回録音・追加入力(followup)・編集指示録音は同時に'recording'状態になり得ないため、
    // どちらのバッファへ書き込むかは各RecordingContextの状態だけで安全に判別できる。
    if (recordingContext.state === 'recording') {
      if (!receivedFirstChunk) {
        receivedFirstChunk = true
        clearFirstChunkTimer()
      }
      const { capped } = buffer.append(pcm)
      if (capped) {
        void finishRecording()
      }
      return
    }

    if (followupRecordingContext.state === 'recording') {
      if (!receivedFirstChunk) {
        receivedFirstChunk = true
        clearFirstChunkTimer()
      }
      const { capped } = followupBuffer.append(pcm)
      if (capped) {
        void finishFollowupRecording()
      }
      return
    }

    if (editRecordingContext.state === 'recording') {
      if (!receivedFirstChunk) {
        receivedFirstChunk = true
        clearFirstChunkTimer()
      }
      const { capped } = editBuffer.append(pcm)
      if (capped) {
        void finishEditRecording()
      }
      return
    }
  }

  async function handleForegroundEnter(): Promise<void> {
    // ペアリング待機中にバックグラウンド化された場合、フォアグラウンド復帰時はホームへ戻さず
    // ペアリング画面のままポーリングだけを再開する(仕様: 「バックグラウンドで停止、フォアグラウンドで安全に再開」)。
    if (currentScreen === 'pairing' && pairingContext.state === 'waitingApproval') {
      logSafe({ event: 'foreground_enter', state: 'pairing_resumed' })
      await showScreen('pairing', screens.pairingScreenText(pairingContext.verificationUrl ?? '', pairingContext.userCode ?? ''))
      schedulePairingPoll(pairingContext.pollIntervalSeconds ?? DEFAULT_PAIRING_POLL_INTERVAL_SECONDS)
      return
    }
    // 未接続/ペアリング成功/ペアリング失敗の各画面は「まだホームメニューに到達していない」ことを表す。
    // これらの間はフォアグラウンド復帰時にホームメニューへは戻さない(未ペアリングのままCalendar機能へ
    // 到達させないため)。
    if (currentScreen === 'notConnected' || currentScreen === 'pairingSuccess' || currentScreen === 'pairingError') {
      logSafe({ event: 'foreground_enter', state: currentScreen })
      return
    }

    clearWatchdog()
    clearFirstChunkTimer()
    buffer.clear()
    recordingContext = initialRecordingContext
    followupBuffer.clear()
    followupRecordingContext = initialRecordingContext
    analysisAbortController?.abort()
    analysisAbortController = null
    analysisContext = initialAnalysisContext
    registrationAbortController?.abort()
    registrationAbortController = null
    registrationContext = initialRegistrationContext
    currentCandidateId = null
    dayEventsAbortController?.abort()
    dayEventsAbortController = null
    dayEventsContext = initialDayEventsContext
    upcomingEventsAbortController?.abort()
    upcomingEventsAbortController = null
    upcomingEventsContext = initialUpcomingEventsContext
    homeMenuIndex = 0
    resetEventDetailFlow()
    if (currentConversationId !== null) {
      const conversationId = currentConversationId
      currentConversationId = null
      fireAndForgetCancelConversation(conversationId)
    }
    logSafe({ event: 'foreground_enter', state: recordingContext.state })
    await showScreen('home', screens.homeScreenText(homeMenuIndex))
  }

  async function handleForegroundExit(): Promise<void> {
    logSafe({ event: 'foreground_exit', state: recordingContext.state })
    if (recordingContext.state === 'recording') {
      clearWatchdog()
      clearFirstChunkTimer()
      await stopMicrophone()
      buffer.clear()
      recordingContext = initialRecordingContext
    }
    if (followupRecordingContext.state === 'recording') {
      clearWatchdog()
      clearFirstChunkTimer()
      await stopMicrophone()
      followupBuffer.clear()
      followupRecordingContext = initialRecordingContext
    }
    if (analysisContext.state === 'analyzing') {
      analysisAbortController?.abort()
      analysisAbortController = null
      analysisContext = initialAnalysisContext
    }
    if (registrationContext.state === 'registering' || registrationContext.state === 'checkingStatus') {
      registrationAbortController?.abort()
      registrationAbortController = null
      registrationContext = initialRegistrationContext
      currentCandidateId = null
    }
    if (dayEventsContext.state === 'loading') {
      dayEventsAbortController?.abort()
      dayEventsAbortController = null
      dayEventsContext = initialDayEventsContext
    }
    if (upcomingEventsContext.state === 'loading') {
      upcomingEventsAbortController?.abort()
      upcomingEventsAbortController = null
      upcomingEventsContext = initialUpcomingEventsContext
    }
    if (editRecordingContext.state === 'recording') {
      clearWatchdog()
      clearFirstChunkTimer()
      await stopMicrophone()
      editBuffer.clear()
      editRecordingContext = initialRecordingContext
    }
    // 詳細取得中/削除中/編集解析中/編集適用中はいずれも進行中フローの副作用(fetch)だけを止める。
    // 復元しない(=画面自体はforegroundEnterで安全な画面へ戻す)という仕様どおり、ここではabortのみ行う。
    if (eventDetailContext.state === 'loading') {
      eventDetailAbortController?.abort()
      eventDetailAbortController = null
      eventDetailContext = initialEventDetailContext
    }
    if (deleteMutationContext.state === 'inProgress') {
      deleteAbortController?.abort()
      deleteAbortController = null
      deleteMutationContext = initialEventMutationContext
    }
    if (editAnalysisContext.state === 'analyzing') {
      editAnalysisAbortController?.abort()
      editAnalysisAbortController = null
      editAnalysisContext = initialEditAnalysisContext
    }
    if (editApplyContext.state === 'inProgress') {
      editApplyAbortController?.abort()
      editApplyAbortController = null
      editApplyContext = initialEventMutationContext
    }
    if (currentConversationId !== null) {
      const conversationId = currentConversationId
      currentConversationId = null
      fireAndForgetCancelConversation(conversationId)
    }
    if (pairingContext.state === 'waitingApproval') {
      // ポーリングだけを停止する。pairingContext自体は保持し、フォアグラウンド復帰時に再開できるようにする。
      clearPairingPollTimer()
      pairingAbortController?.abort()
      pairingAbortController = null
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    clearWatchdog()
    clearFirstChunkTimer()
    void stopMicrophone()
    buffer.clear()
    followupBuffer.clear()
    analysisAbortController?.abort()
    analysisAbortController = null
    registrationAbortController?.abort()
    registrationAbortController = null
    dayEventsAbortController?.abort()
    dayEventsAbortController = null
    upcomingEventsAbortController?.abort()
    upcomingEventsAbortController = null
    eventDetailAbortController?.abort()
    eventDetailAbortController = null
    deleteAbortController?.abort()
    deleteAbortController = null
    editAnalysisAbortController?.abort()
    editAnalysisAbortController = null
    editApplyAbortController?.abort()
    editApplyAbortController = null
    clearPairingPollTimer()
    pairingAbortController?.abort()
    pairingAbortController = null
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    listenerAttached = false
  }

  function attachListener(): void {
    if (listenerAttached) return
    listenerAttached = true

    unsubscribe = bridge.onEvenHubEvent((event) => {
      const audio = event.audioEvent
      if (audio?.audioPcm) {
        onAudioEvent(audio.audioPcm)
      }

      if (event.textEvent) {
        const type = event.textEvent.eventType ?? 0
        if (type === OsEventTypeList.SCROLL_TOP_EVENT) {
          void handleSwipeUp()
          return
        }
        if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
          void handleSwipeDown()
          return
        }
        return
      }

      if (event.sysEvent) {
        const type = event.sysEvent.eventType ?? 0
        if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
          void handleDoublePress()
          return
        }
        if (type === OsEventTypeList.CLICK_EVENT) {
          void handlePress()
          return
        }
        if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
          void handleForegroundEnter()
          return
        }
        if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
          void handleForegroundExit()
          return
        }
        if (type === OsEventTypeList.ABNORMAL_EXIT_EVENT || type === OsEventTypeList.SYSTEM_EXIT_EVENT) {
          dispose()
          return
        }
      }
    })
  }

  async function start(): Promise<void> {
    // ロケール解決(サーバへ送出するlocale query/bodyの値を決める)。Even Hub SDKにはlocale APIが
    // 無いため、保存済み値(bridge)> navigator.languages > 'ja' の優先順で決定する。
    // deps.locale指定時はテスト用の決定的注入として検出をスキップする。既存動作(locale未検出時の
    // 挙動)には一切影響しない(各クライアントはlocale未指定時と完全同一のURL/bodyになる設計のため)。
    if (configuredLocale) {
      setActiveLocale(configuredLocale)
    } else {
      const stored = await loadLocale(bridge).catch(() => null)
      setActiveLocale(detectLocale({ stored, navigatorLanguages: globalThis.navigator?.languages }))
    }

    // devセッションが有効な間はdevモード(既存動作を変えない)。製品モードでは、有効な
    // device credential(refresh tokenが未失効)を既に保持していればホームへ、なければ
    // 未接続画面を最初に表示する(Calendar/Gemini APIはペアリング完了前には一切呼ばれない)。
    let initialScreen: ScreenId = 'home'
    if (isProductMode) {
      const credential = tokenStore ? await tokenStore.load() : null
      const hasValidRefresh = credential !== null && new Date(credential.refreshTokenExpiresAt).getTime() > Date.now()
      initialScreen = hasValidRefresh ? 'home' : 'notConnected'
    }
    currentScreen = initialScreen

    const container = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      content: initialScreen === 'notConnected' ? screens.notConnectedScreenText() : screens.homeScreenText(homeMenuIndex),
      isEventCapture: 1,
    })

    const result = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [container] }),
    )
    logSafe({ event: 'startup_page_created', startResult: result === 0, state: isProductMode ? 'product' : 'dev' })

    attachListener()

    const backendAvailable = await checkBackendHealth(baseUrl).catch(() => false)
    logSafe({ event: 'backend_health_checked', backendAvailable })
    await saveBackendAvailable(bridge, backendAvailable).catch(() => {})
  }

  return {
    start,
    dispose,
    getScreen: () => currentScreen,
    getRecordingContext: () => recordingContext,
    getAnalysisContext: () => analysisContext,
    getRegistrationContext: () => registrationContext,
    getFollowupRecordingContext: () => followupRecordingContext,
    getHomeMenuIndex: () => homeMenuIndex,
    getDayEventsContext: () => dayEventsContext,
    getUpcomingEventsContext: () => upcomingEventsContext,
    getPairingContext: () => pairingContext,
    getEventDetailContext: () => eventDetailContext,
    getEventDetailMenuIndex: () => eventDetailMenuIndex,
    getDeleteMutationContext: () => deleteMutationContext,
    getEditRecordingContext: () => editRecordingContext,
    getEditAnalysisContext: () => editAnalysisContext,
    getEditApplyContext: () => editApplyContext,
  }
}
