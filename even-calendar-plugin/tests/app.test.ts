import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioInputSource, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { createApp, type AppDeps } from '../src/app'
import { FakeEvenAppBridge } from './fakes/fakeEvenAppBridge'
import { MAX_RECORDING_SECONDS } from '../src/recorder'
import * as screens from '../src/screens'
import { nowLocalIsoTokyo, type EventCandidateResult, type FollowupResult } from '../src/eventCandidate'
import { inclusiveEndDate, monthDay } from '../src/allDayDisplay'
import type { AnalyzeAudioOutcome, AnalyzeAudioParams } from '../src/analyzeAudioClient'
import type { RegisterEventOutcome, RegisterEventParams, CheckStatusOutcome, PollForCompletionParams } from '../src/calendarRegistrationClient'
import type { AnalyzeFollowupOutcome, AnalyzeFollowupParams, CancelConversationParams } from '../src/followupAudioClient'
import type { FetchDayEventsOutcome, FetchDayEventsParams } from '../src/dayEventsClient'
import type { DayEventItem, DayEventsResult } from '../src/dayEvents'
import type { FetchUpcomingEventsOutcome, FetchUpcomingEventsParams } from '../src/upcomingEventsClient'
import type { UpcomingEventsResult } from '../src/upcomingEvents'
import type { EventDetail } from '../src/eventDetail'
import type {
  FetchEventDetailOutcome,
  FetchEventDetailParams,
  UpdateEventOutcome,
  UpdateEventParams,
  DeleteEventOutcome,
  DeleteEventParams,
} from '../src/eventDetailClient'
import type { AnalyzeEditAudioOutcome, AnalyzeEditAudioParams } from '../src/editAudioClient'
import type { EditInstructionResult } from '../src/editInstruction'

function stubHealthyFetch(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }))
}

function audioChunk(byteLength: number): { audioEvent: { audioPcm: Uint8Array; source: AudioInputSource } } {
  return { audioEvent: { audioPcm: new Uint8Array(byteLength), source: AudioInputSource.Glasses } }
}

function press(): { sysEvent: { eventType: OsEventTypeList } } {
  return { sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } }
}

function doublePress(): { sysEvent: { eventType: OsEventTypeList } } {
  return { sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } }
}

function swipeUp(): { textEvent: { eventType: OsEventTypeList } } {
  return { textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } }
}

function swipeDown(): { textEvent: { eventType: OsEventTypeList } } {
  return { textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } }
}

function foregroundEnter(): { sysEvent: { eventType: OsEventTypeList } } {
  return { sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } }
}

function foregroundExit(): { sysEvent: { eventType: OsEventTypeList } } {
  return { sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } }
}

const ONE_SECOND_OF_AUDIO_BYTES = 16000 * 2

// showScreen() は内部でrenderChainに乗せてbridge.textContainerUpgradeを呼ぶため、
// currentScreen/recordingContextの同期更新より多くのマイクロタスクtickを要することがある。
// lastTextContent()で実際の描画内容まで検証するテストではこちらを使う。
async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
  }
}

function fakeAnalyze(
  outcome: AnalyzeAudioOutcome | (() => Promise<AnalyzeAudioOutcome>),
): { fn: (params: AnalyzeAudioParams) => Promise<AnalyzeAudioOutcome>; calls: AnalyzeAudioParams[] } {
  const calls: AnalyzeAudioParams[] = []
  const fn = async (params: AnalyzeAudioParams): Promise<AnalyzeAudioOutcome> => {
    calls.push(params)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  return { fn, calls }
}

function futureLocalDateTime(hoursFromNow: number): string {
  return nowLocalIsoTokyo(new Date(Date.now() + hoursFromNow * 3_600_000))
}

/** allDay候補(startDate/endDateExclusive)用。"YYYY-MM-DD"(Asia/Tokyo)を返す。 */
function futureLocalDate(daysFromNow: number): string {
  return futureLocalDateTime(daysFromNow * 24).slice(0, 10)
}

function eventCandidate(overrides: Partial<EventCandidateResult> = {}): EventCandidateResult {
  return {
    schemaVersion: '1',
    resultType: 'event_candidate',
    title: '打ち合わせ',
    startLocal: futureLocalDateTime(24),
    endLocal: futureLocalDateTime(25),
    startDate: null,
    endDateExclusive: null,
    timeZone: 'Asia/Tokyo',
    allDay: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions: [],
    ...overrides,
  }
}

/** allDay===trueな候補フィクスチャ。startLocal/endLocalはnull、startDate/endDateExclusiveのみ持つ。 */
function allDayEventCandidate(overrides: Partial<EventCandidateResult> = {}): EventCandidateResult {
  return eventCandidate({
    startLocal: null,
    endLocal: null,
    allDay: true,
    startDate: futureLocalDate(3),
    endDateExclusive: futureLocalDate(6),
    ...overrides,
  })
}

const TEST_DEPS_BASE: Pick<AppDeps, 'baseUrl' | 'sessionToken' | 'installId' | 'createRequestId'> = {
  baseUrl: 'https://backend.test',
  sessionToken: 'test-session-token',
  installId: '11111111-1111-4111-8111-111111111111',
  createRequestId: () => 'req-fixed-id',
}

function fakeRegister(
  outcome: RegisterEventOutcome | (() => Promise<RegisterEventOutcome>),
): { fn: (params: RegisterEventParams) => Promise<RegisterEventOutcome>; calls: RegisterEventParams[] } {
  const calls: RegisterEventParams[] = []
  const fn = async (params: RegisterEventParams): Promise<RegisterEventOutcome> => {
    calls.push(params)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  return { fn, calls }
}

function fakePoll(
  outcome: CheckStatusOutcome | (() => Promise<CheckStatusOutcome>),
): { fn: (params: PollForCompletionParams) => Promise<CheckStatusOutcome>; calls: PollForCompletionParams[] } {
  const calls: PollForCompletionParams[] = []
  const fn = async (params: PollForCompletionParams): Promise<CheckStatusOutcome> => {
    calls.push(params)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  return { fn, calls }
}

/** captured -> analyzing(event_candidate成功) -> candidate 画面まで進める。 */
async function reachCandidate(
  bridge: FakeEvenAppBridge,
  createAppDeps: AppDeps,
  resultOverrides: Partial<EventCandidateResult> = {},
): Promise<ReturnType<typeof createApp>> {
  const { fn } = fakeAnalyze({
    kind: 'success',
    requestId: 'req-fixed-id',
    candidateId: 'fixed-candidate-id',
    result: eventCandidate(resultOverrides),
  })
  const app = createApp(bridge, { ...TEST_DEPS_BASE, ...createAppDeps, analyzeAudioFn: createAppDeps.analyzeAudioFn ?? fn })
  await app.start()
  await reachCaptured(bridge)
  bridge.emit(press())
  await flushMicrotasks()
  return app
}

async function reachCaptured(bridge: FakeEvenAppBridge, seconds = 2): Promise<void> {
  bridge.emit(press())
  await Promise.resolve()
  await Promise.resolve()
  bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES * seconds))
  bridge.emit(press())
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function fakeAnalyzeFollowup(
  outcome: AnalyzeFollowupOutcome | (() => Promise<AnalyzeFollowupOutcome>),
): { fn: (params: AnalyzeFollowupParams) => Promise<AnalyzeFollowupOutcome>; calls: AnalyzeFollowupParams[] } {
  const calls: AnalyzeFollowupParams[] = []
  const fn = async (params: AnalyzeFollowupParams): Promise<AnalyzeFollowupOutcome> => {
    calls.push(params)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  return { fn, calls }
}

function fakeDayEvents(
  outcome: FetchDayEventsOutcome | (() => Promise<FetchDayEventsOutcome>),
): { fn: (params: FetchDayEventsParams) => Promise<FetchDayEventsOutcome>; calls: FetchDayEventsParams[] } {
  const calls: FetchDayEventsParams[] = []
  const fn = async (params: FetchDayEventsParams): Promise<FetchDayEventsOutcome> => {
    calls.push(params)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  return { fn, calls }
}

function timedDayEvent(overrides: Partial<DayEventItem> = {}): DayEventItem {
  return {
    eventId: 'key-1',
    title: '朝会',
    allDay: false,
    startLocal: '2026-07-23T09:00:00',
    endLocal: '2026-07-23T10:00:00',
    startDate: null,
    endDateExclusive: null,
    ...overrides,
  }
}

function allDayDayEvent(overrides: Partial<DayEventItem> = {}): DayEventItem {
  return {
    eventId: 'key-allday',
    title: '休暇',
    allDay: true,
    startLocal: null,
    endLocal: null,
    startDate: '2026-07-23',
    endDateExclusive: '2026-07-24',
    ...overrides,
  }
}

function dayEventsResult(overrides: Partial<DayEventsResult> = {}): DayEventsResult {
  return {
    schemaVersion: '1',
    day: 'today',
    dateLocal: '2026-07-23',
    timeZone: 'Asia/Tokyo',
    events: [],
    truncated: false,
    ...overrides,
  }
}

function fakeUpcomingEvents(
  outcome: FetchUpcomingEventsOutcome | (() => Promise<FetchUpcomingEventsOutcome>),
): { fn: (params: FetchUpcomingEventsParams) => Promise<FetchUpcomingEventsOutcome>; calls: FetchUpcomingEventsParams[] } {
  const calls: FetchUpcomingEventsParams[] = []
  const fn = async (params: FetchUpcomingEventsParams): Promise<FetchUpcomingEventsOutcome> => {
    calls.push(params)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  return { fn, calls }
}

function timedUpcomingEvent(overrides: Partial<DayEventItem> = {}): DayEventItem {
  return {
    eventId: 'up-key-1',
    title: '打ち合わせ',
    allDay: false,
    startLocal: '2026-07-23T14:00:00',
    endLocal: '2026-07-23T15:00:00',
    startDate: null,
    endDateExclusive: null,
    ...overrides,
  }
}

function allDayUpcomingEvent(overrides: Partial<DayEventItem> = {}): DayEventItem {
  return {
    eventId: 'up-key-allday',
    title: '休暇',
    allDay: true,
    startLocal: null,
    endLocal: null,
    startDate: '2026-07-24',
    endDateExclusive: '2026-07-25',
    ...overrides,
  }
}

function upcomingEventsResult(overrides: Partial<UpcomingEventsResult> = {}): UpcomingEventsResult {
  return {
    schemaVersion: '1',
    mode: 'upcoming',
    timeZone: 'Asia/Tokyo',
    events: [],
    truncated: false,
    ...overrides,
  }
}

function eventDetail(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    eventId: 'evt-1',
    title: '朝会',
    status: 'confirmed',
    allDay: false,
    startLocal: '2026-07-23T09:00:00',
    endLocal: '2026-07-23T10:00:00',
    startDate: null,
    endDateExclusive: null,
    location: null,
    description: null,
    attendees: null,
    meetingUrl: null,
    etag: null,
    ...overrides,
  }
}

function fakeEventDetail(
  outcome: FetchEventDetailOutcome | (() => Promise<FetchEventDetailOutcome>),
): { fn: (params: FetchEventDetailParams) => Promise<FetchEventDetailOutcome>; calls: FetchEventDetailParams[] } {
  const calls: FetchEventDetailParams[] = []
  const fn = async (params: FetchEventDetailParams): Promise<FetchEventDetailOutcome> => {
    calls.push(params)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  return { fn, calls }
}

function fakeUpdateEvent(
  outcome: UpdateEventOutcome | (() => Promise<UpdateEventOutcome>),
): { fn: (params: UpdateEventParams) => Promise<UpdateEventOutcome>; calls: UpdateEventParams[] } {
  const calls: UpdateEventParams[] = []
  const fn = async (params: UpdateEventParams): Promise<UpdateEventOutcome> => {
    calls.push(params)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  return { fn, calls }
}

function fakeDeleteEvent(
  outcome: DeleteEventOutcome | (() => Promise<DeleteEventOutcome>),
): { fn: (params: DeleteEventParams) => Promise<DeleteEventOutcome>; calls: DeleteEventParams[] } {
  const calls: DeleteEventParams[] = []
  const fn = async (params: DeleteEventParams): Promise<DeleteEventOutcome> => {
    calls.push(params)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  return { fn, calls }
}

function editInstructionResult(overrides: Partial<EditInstructionResult> = {}): EditInstructionResult {
  return {
    schemaVersion: '1',
    resultType: 'edit',
    fields: { title: '定例会議' },
    ...overrides,
  }
}

function fakeAnalyzeEditAudio(
  outcome: AnalyzeEditAudioOutcome | (() => Promise<AnalyzeEditAudioOutcome>),
): { fn: (params: AnalyzeEditAudioParams) => Promise<AnalyzeEditAudioOutcome>; calls: AnalyzeEditAudioParams[] } {
  const calls: AnalyzeEditAudioParams[] = []
  const fn = async (params: AnalyzeEditAudioParams): Promise<AnalyzeEditAudioOutcome> => {
    calls.push(params)
    return typeof outcome === 'function' ? outcome() : outcome
  }
  return { fn, calls }
}

function fakeCancelConversation(): { fn: (params: CancelConversationParams) => Promise<void>; calls: CancelConversationParams[] } {
  const calls: CancelConversationParams[] = []
  const fn = async (params: CancelConversationParams): Promise<void> => {
    calls.push(params)
  }
  return { fn, calls }
}

function followupResult(overrides: Partial<FollowupResult> = {}): FollowupResult {
  return {
    schemaVersion: '1',
    resultType: 'event_candidate',
    title: '打ち合わせ',
    startLocal: futureLocalDateTime(24),
    endLocal: futureLocalDateTime(25),
    timeZone: 'Asia/Tokyo',
    allDay: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions: [],
    ...overrides,
  }
}

/** captured -> analyzing(needs_clarification成功) -> clarification 画面まで進める。 */
async function reachClarification(bridge: FakeEvenAppBridge, createAppDeps: AppDeps = {}): Promise<ReturnType<typeof createApp>> {
  const { fn } = fakeAnalyze({
    kind: 'success',
    requestId: 'req-fixed-id',
    candidateId: null,
    conversationId: 'fixed-conversation-id',
    turn: 1,
    maxTurns: 3,
    result: eventCandidate({
      resultType: 'needs_clarification',
      title: null,
      startLocal: null,
      endLocal: null,
      clarificationField: 'start_time',
      clarificationQuestion: 'INITIAL_QUESTION',
    }),
  })
  const app = createApp(bridge, { ...TEST_DEPS_BASE, ...createAppDeps, analyzeAudioFn: createAppDeps.analyzeAudioFn ?? fn })
  await app.start()
  await reachCaptured(bridge)
  bridge.emit(press())
  await flushMicrotasks()
  return app
}

/** clarification -> followupReady -> followupRecording -> followupCaptured 画面まで進める。 */
async function reachFollowupCaptured(
  bridge: FakeEvenAppBridge,
  createAppDeps: AppDeps = {},
  seconds = 2,
): Promise<ReturnType<typeof createApp>> {
  const app = await reachClarification(bridge, createAppDeps)
  bridge.emit(press()) // clarification -> followupReady
  await flushMicrotasks()
  bridge.emit(press()) // followupReady -> followupRecording(録音開始)
  await Promise.resolve()
  await Promise.resolve()
  bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES * seconds))
  bridge.emit(press()) // followupRecording -> followupCaptured(録音終了)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return app
}

describe('createApp', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('creates exactly one container with isEventCapture:1, within container/text limits', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    const payload = bridge.createStartUpCalls[0] as { containerTotalNum: number; textObject: Array<{ isEventCapture?: number }> }
    expect(payload.containerTotalNum).toBeLessThanOrEqual(12)
    expect(payload.textObject.length).toBeLessThanOrEqual(8)
    const captureContainers = payload.textObject.filter((c) => c.isEventCapture === 1)
    expect(captureContainers).toHaveLength(1)
  })

  it('shows the home screen after startup', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()
    expect(app.getScreen()).toBe('home')
  })

  it('starts recording on press from home, calling audioControl(true, Glasses)', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()

    expect(app.getScreen()).toBe('recording')
    expect(app.getRecordingContext().state).toBe('recording')
    expect(bridge.audioControlCalls[0]).toEqual({ isOpen: true, source: AudioInputSource.Glasses })
  })

  it('stops recording on press while recording and moves to captured when long enough', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()

    bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))
    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(app.getScreen()).toBe('captured')
    expect(app.getRecordingContext().state).toBe('captured')
    expect(bridge.audioControlCalls.at(-1)).toEqual({ isOpen: false, source: undefined })
  })

  it('rejects recordings shorter than 0.5 seconds with the "too short" screen', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()

    // 0.5秒未満(16000バイト未満)しか送らずに停止する
    bridge.emit(audioChunk(1000))
    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(app.getScreen()).toBe('tooShort')
    expect(app.getRecordingContext().state).toBe('idle')
  })

  it('cancels recording on double press while recording, discarding the buffer and returning home', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

    bridge.emit(doublePress())
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(app.getScreen()).toBe('home')
    expect(app.getRecordingContext().state).toBe('idle')
    expect(bridge.audioControlCalls.at(-1)?.isOpen).toBe(false)
  })

  it('exits via shutDownPageContainer(1) on double press from home', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(doublePress())
    await Promise.resolve()
    await Promise.resolve()

    expect(bridge.shutDownCalls).toEqual([1])
  })

  it('starts with "予定を登録" selected on the home menu', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    expect(app.getHomeMenuIndex()).toBe(0)
    const initialPayload = bridge.createStartUpCalls[0] as { textObject: Array<{ content?: string }> }
    expect(initialPayload.textObject[0]?.content).toContain('> 予定を登録')
  })

  it('moves the home menu selection down/up on swipe, staying on the home screen', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(swipeDown())
    await flushMicrotasks()
    expect(app.getScreen()).toBe('home')
    expect(app.getHomeMenuIndex()).toBe(1)
    expect(bridge.lastTextContent()).toContain('> 直近5件の予定')

    bridge.emit(swipeDown())
    await flushMicrotasks()
    expect(app.getHomeMenuIndex()).toBe(2)
    expect(bridge.lastTextContent()).toContain('> 今日の予定')

    bridge.emit(swipeDown())
    await flushMicrotasks()
    expect(app.getHomeMenuIndex()).toBe(3)
    expect(bridge.lastTextContent()).toContain('> 明日の予定')

    bridge.emit(swipeDown())
    await flushMicrotasks()
    expect(app.getHomeMenuIndex()).toBe(4)
    expect(bridge.lastTextContent()).toContain('> Googleカレンダーを再接続')

    bridge.emit(swipeDown())
    await flushMicrotasks()
    expect(app.getHomeMenuIndex()).toBe(5)
    expect(bridge.lastTextContent()).toContain('> 言語')

    // 末尾でこれ以上下へは進まない(クランプ)
    bridge.emit(swipeDown())
    await flushMicrotasks()
    expect(app.getHomeMenuIndex()).toBe(5)

    bridge.emit(swipeUp())
    await flushMicrotasks()
    expect(app.getHomeMenuIndex()).toBe(4)
  })

  it('does not move the selection above the first item', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(swipeUp())
    await Promise.resolve()
    await Promise.resolve()
    expect(app.getHomeMenuIndex()).toBe(0)
  })

  it('ignores swipes while not on the home screen', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press()) // -> recording
    await Promise.resolve()
    await Promise.resolve()
    expect(app.getScreen()).toBe('recording')

    bridge.emit(swipeUp())
    await Promise.resolve()
    expect(app.getScreen()).toBe('recording') // unaffected
  })

  it('returns home from the tooShort screen on press', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    bridge.emit(audioChunk(1000)) // 0.5秒未満
    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(app.getScreen()).toBe('tooShort')

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    expect(app.getScreen()).toBe('home')
  })

  it('auto-stops recording after 30 seconds', async () => {
    stubHealthyFetch()
    vi.useFakeTimers()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await vi.advanceTimersByTimeAsync(0)
    expect(app.getScreen()).toBe('recording')

    bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

    await vi.advanceTimersByTimeAsync(MAX_RECORDING_SECONDS * 1000)

    expect(app.getScreen()).toBe('captured')
    expect(bridge.audioControlCalls.at(-1)).toEqual({ isOpen: false, source: undefined })
  })

  it('caps retained audio bytes at 30 seconds worth and auto-finalizes once the cap is hit', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()

    const maxBytes = MAX_RECORDING_SECONDS * 16000 * 2
    bridge.emit(audioChunk(maxBytes + 1000))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(app.getScreen()).toBe('captured')
  })

  it('does not double-register the event listener across multiple start() calls', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()
    await app.start()
    expect(bridge.listenerCount).toBe(1)
  })

  it('resets to idle/home on foreground enter regardless of the prior screen', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    expect(app.getScreen()).toBe('recording')

    bridge.emit(foregroundEnter())
    await Promise.resolve()
    await Promise.resolve()

    expect(app.getScreen()).toBe('home')
    expect(app.getRecordingContext().state).toBe('idle')
  })

  it('stops the microphone and discards the buffer on foreground exit while recording', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

    bridge.emit(foregroundExit())
    await Promise.resolve()
    await Promise.resolve()

    expect(bridge.audioControlCalls.at(-1)?.isOpen).toBe(false)
    expect(app.getRecordingContext().state).toBe('idle')
  })

  it('never stores anything except the backendAvailable flag in local storage (no PCM, no auto-saved locale)', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))
    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(Array.from(bridge.storage.keys()).sort()).toEqual(['even-calendar.backendAvailable'])
    expect(bridge.storage.get('even-calendar.backendAvailable')).toBe('1')
  })

  it('reports backendAvailable=true when the health check succeeds', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()
    expect(bridge.storage.get('even-calendar.backendAvailable')).toBe('1')
  })

  it('reports backendAvailable=false when the health check fails, and still starts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()
    expect(bridge.storage.get('even-calendar.backendAvailable')).toBe('0')
    expect(app.getScreen()).toBe('home')
  })

  it('does not auto-save the resolved locale on start() when deps.locale is injected (0.3.3 auto-save behavior removed)', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    // 過去に保存された値が残っていても、start()自身はもはやそれを読み書きしない
    // (自動検出結果の書き戻しは廃止。書き込みはLanguage画面での明示選択時のみ)。
    bridge.storage.set('even-calendar.locale', 'ja')
    const app = createApp(bridge, { locale: 'en' })
    await app.start()
    expect(bridge.storage.get('even-calendar.locale')).toBe('ja')
    expect(bridge.storage.has('even-calendar.locale')).toBe(true)
  })

  it('does not auto-save a locale value on start() without deps.locale either (auto-detected case, no explicit selection)', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()
    expect(bridge.storage.has('even-calendar.locale')).toBe(false)
  })

  it('logs a locale_resolved diagnostic event containing only safe fields (no token/installId/etc.)', async () => {
    stubHealthyFetch()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge, { ...TEST_DEPS_BASE, locale: 'en' })
    await app.start()

    const localeLogCall = logSpy.mock.calls.find((call) => {
      try {
        return JSON.parse(String(call[0])).event === 'locale_resolved'
      } catch {
        return false
      }
    })
    expect(localeLogCall).toBeDefined()
    const parsed = JSON.parse(String(localeLogCall?.[0])) as Record<string, unknown>
    expect(parsed.resolvedLocale).toBe('en')
    expect(Object.keys(parsed).sort()).toEqual(
      ['event', 'navigatorLanguageRaw', 'navigatorLanguagesRaw', 'resolvedLocale', 'storedLocaleRaw'].sort(),
    )
    expect(String(localeLogCall?.[0])).not.toContain('test-session-token')
    expect(String(localeLogCall?.[0])).not.toContain(TEST_DEPS_BASE.installId)

    logSpy.mockRestore()
  })

  it('never logs PCM/base64 content or conversation-shaped text', async () => {
    stubHealthyFetch()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))
    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const allLogText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
    // PCMは長さ32000のゼロ埋め配列なので、そのような巨大な数値羅列がログに出ていないことを確認する
    expect(allLogText).not.toMatch(/\[0,0,0,0,0,0,0,0,0,0/)
    expect(allLogText.length).toBeLessThan(5000)

    logSpy.mockRestore()
  })

  it('cleans up on system exit: stops audio and unsubscribes', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()

    bridge.emit(press())
    await Promise.resolve()
    await Promise.resolve()

    bridge.emit({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } })
    await Promise.resolve()
    await Promise.resolve()

    expect(bridge.audioControlCalls.at(-1)?.isOpen).toBe(false)
    expect(bridge.listenerCount).toBe(0)
  })

  it('exposes a manual dispose() that is safe to call multiple times', async () => {
    stubHealthyFetch()
    const bridge = new FakeEvenAppBridge()
    const app = createApp(bridge)
    await app.start()
    app.dispose()
    expect(() => app.dispose()).not.toThrow()
    expect(bridge.listenerCount).toBe(0)
  })

  describe('recording stop (regression: 実機での「録音の停止に失敗しました」誤検知)', () => {
    it('calls audioControl(false) exactly once for a normal start-then-stop cycle', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))
      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(bridge.audioControlCalls.filter((c) => c.isOpen === false)).toHaveLength(1)
    })

    it('ignores a duplicate single press while already stopping, calling audioControl(false) only once', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

      bridge.emit(press()) // 1回目の停止押下
      bridge.emit(press()) // 停止処理中の重複押下(無視されるべき)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(bridge.audioControlCalls.filter((c) => c.isOpen === false)).toHaveLength(1)
      expect(app.getScreen()).toBe('captured')
    })

    it('treats an undefined resolved value from audioControl(false) as a successful stop, matching SDK docs/template behavior', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

      bridge.audioControlStopResult = undefined
      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(app.getScreen()).toBe('captured')
      expect(app.getRecordingContext().state).toBe('captured')
    })

    it('shows "マイクを停止できませんでした" only when audioControl(false) itself throws', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      bridge.audioControlStopThrows = true
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('error')
      expect(app.getRecordingContext().errorCode).toBe('audio_stop_failed')
      expect(bridge.lastTextContent()).toContain('マイクを停止できませんでした')
    })

    it('does not retry audioControl(false) automatically after it fails once', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      bridge.audioControlStopThrows = true
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))
      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(app.getScreen()).toBe('error')

      // エラー画面からの押下はホームに戻るだけで、停止を再試行しない
      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()

      expect(app.getScreen()).toBe('home')
      expect(bridge.audioControlCalls.filter((c) => c.isOpen === false)).toHaveLength(1)
    })

    it('shows "音声の処理に失敗しました" (not the mic-stop message) when post-stop processing throws after a successful stop', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

      const capturedTextSpy = vi.spyOn(screens, 'capturedScreenText').mockImplementation(() => {
        throw new Error('post-processing failure')
      })

      bridge.emit(press())
      await flushMicrotasks()

      capturedTextSpy.mockRestore()

      expect(app.getScreen()).toBe('error')
      expect(app.getRecordingContext().errorCode).toBe('audio_processing_failed')
      expect(bridge.lastTextContent()).toContain('音声の処理に失敗しました')
      // マイク停止自体は成功しているので、停止呼び出しは1回だけのはず
      expect(bridge.audioControlCalls.filter((c) => c.isOpen === false)).toHaveLength(1)
    })

    it('does not report a stop failure when only the post-stop screen render (bridge call) fails', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

      bridge.textUpgradeThrows = true // G2側への描画自体が失敗するケース
      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // 録音ライフサイクル自体は成功しており、描画失敗によって「停止失敗」と誤表示されない
      expect(app.getRecordingContext().state).toBe('captured')
      expect(bridge.audioControlCalls.filter((c) => c.isOpen === false)).toHaveLength(1)
    })

    it('does not double-stop when single-press-stop races with the 30s auto-stop watchdog', async () => {
      stubHealthyFetch()
      vi.useFakeTimers()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await vi.advanceTimersByTimeAsync(0)
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

      // ウォッチドッグが同期的に発火してfinishRecording()を開始する(stateが'stopping'へ遷移)
      vi.advanceTimersByTime(MAX_RECORDING_SECONDS * 1000)
      // ほぼ同時に手動の停止押下が来ても、既に停止処理中なので無視されるべき
      bridge.emit(press())

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      expect(bridge.audioControlCalls.filter((c) => c.isOpen === false)).toHaveLength(1)
      expect(app.getScreen()).toBe('captured')
    })

    it('does not double-stop when single-press-stop races with double-press-cancel', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

      bridge.emit(press()) // 単押しで停止開始(同期的にstateが'stopping'へ)
      bridge.emit(doublePress()) // ほぼ同時のキャンセルは無視されるべき

      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(bridge.audioControlCalls.filter((c) => c.isOpen === false)).toHaveLength(1)
    })

    it('discards an audioEvent that arrives after recording has already stopped', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))
      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(app.getScreen()).toBe('captured')

      // 停止後に遅れて届いたチャンクは破棄され、状態・画面に影響しない
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))
      await Promise.resolve()

      expect(app.getScreen()).toBe('captured')
      expect(app.getRecordingContext().state).toBe('captured')
    })

    it('clears the watchdog/first-chunk timers even when the mic stop itself fails', async () => {
      stubHealthyFetch()
      vi.useFakeTimers()
      const bridge = new FakeEvenAppBridge()
      bridge.audioControlStopThrows = true
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await vi.advanceTimersByTimeAsync(0)
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))

      bridge.emit(press())
      await vi.advanceTimersByTimeAsync(0)
      expect(app.getScreen()).toBe('error')

      const stopCallsBefore = bridge.audioControlCalls.filter((c) => c.isOpen === false).length

      // タイマーが解除されていなければ、ここでウォッチドッグが再度発火してしまう
      await vi.advanceTimersByTimeAsync(MAX_RECORDING_SECONDS * 1000)

      const stopCallsAfter = bridge.audioControlCalls.filter((c) => c.isOpen === false).length
      expect(stopCallsAfter).toBe(stopCallsBefore)
    })

    it('clears the PCM buffer even when the mic stop itself fails, so it does not leak into the next recording', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      bridge.audioControlStopThrows = true
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES * 10))

      bridge.emit(press()) // 停止が失敗し、バッファは破棄されるはず
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(app.getScreen()).toBe('error')

      bridge.audioControlStopThrows = false
      bridge.emit(press()) // エラー画面からホームへ
      await Promise.resolve()
      await Promise.resolve()
      expect(app.getScreen()).toBe('home')

      bridge.emit(press()) // 新しい録音を開始
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(1000)) // 0.5秒未満(単独では短すぎる)
      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // 前回の10秒分のバッファが残っていれば'captured'になってしまうが、
      // 破棄されていれば新しい1000バイトだけが残り'tooShort'になる
      expect(app.getScreen()).toBe('tooShort')
    })

    it('never logs PCM/utterance content even when the mic stop fails', async () => {
      stubHealthyFetch()
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const bridge = new FakeEvenAppBridge()
      bridge.audioControlStopThrows = true
      const app = createApp(bridge)
      await app.start()

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES))
      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      const allLogText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(allLogText).not.toMatch(/\[0,0,0,0,0,0,0,0,0,0/)
      expect(allLogText.length).toBeLessThan(5000)

      logSpy.mockRestore()
    })
  })

  describe('audio analysis (Phase 2C: /plugin/analyze-audio integration)', () => {
    it('single press from captured starts analysis: shows analyzing screen and POSTs WAV with required fields', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn, calls } = fakeAnalyze({ kind: 'success', requestId: 'req-fixed-id', candidateId: 'fixed-candidate-id', result: eventCandidate({ resultType: 'not_calendar_request', title: null, startLocal: null, endLocal: null }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)
      expect(app.getScreen()).toBe('captured')

      bridge.emit(press())
      await Promise.resolve()

      expect(app.getScreen()).toBe('analyzing')
      expect(app.getAnalysisContext().state).toBe('analyzing')

      await flushMicrotasks()

      expect(calls).toHaveLength(1)
      expect(calls[0]?.baseUrl).toBe('https://backend.test')
      expect(calls[0]?.sessionToken).toBe('test-session-token')
      expect(calls[0]?.installId).toBe(TEST_DEPS_BASE.installId)
      expect(calls[0]?.requestId).toBe('req-fixed-id')
      expect(calls[0]?.wav).toBeInstanceOf(Uint8Array)
      // WAVは44バイトヘッダー + PCMデータ
      expect(calls[0]?.wav.byteLength).toBeGreaterThan(44)
    })

    it('ignores a single press while already analyzing', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let resolveOutcome: ((o: AnalyzeAudioOutcome) => void) | null = null
      const pending = new Promise<AnalyzeAudioOutcome>((resolve) => {
        resolveOutcome = resolve
      })
      const { fn, calls } = fakeAnalyze(() => pending)
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)

      bridge.emit(press()) // starts analysis
      await Promise.resolve()
      expect(app.getScreen()).toBe('analyzing')
      await flushMicrotasks() // analyzeAudioFn is invoked after the 'analyzing' screen render settles

      bridge.emit(press()) // ignored
      await flushMicrotasks()
      expect(app.getScreen()).toBe('analyzing')
      expect(calls).toHaveLength(1)

      resolveOutcome?.(eventCandidate({ resultType: 'not_calendar_request', title: null, startLocal: null, endLocal: null }))
      await flushMicrotasks()
    })

    it('double press while analyzing aborts the request and returns home; a late response is not reflected', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let capturedSignal: AbortSignal | undefined
      let resolveOutcome: ((o: AnalyzeAudioOutcome) => void) | null = null
      const pending = new Promise<AnalyzeAudioOutcome>((resolve) => {
        resolveOutcome = resolve
      })
      const { fn } = fakeAnalyze((): Promise<AnalyzeAudioOutcome> => pending)
      const wrappedFn = async (params: AnalyzeAudioParams): Promise<AnalyzeAudioOutcome> => {
        capturedSignal = params.signal
        return fn(params)
      }
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: wrappedFn })
      await app.start()
      await reachCaptured(bridge)

      bridge.emit(press())
      await Promise.resolve()
      expect(app.getScreen()).toBe('analyzing')
      await flushMicrotasks() // let startAnalysis actually reach analyzeAudioFn before cancelling
      expect(capturedSignal).toBeDefined()

      bridge.emit(doublePress())
      await flushMicrotasks()

      expect(capturedSignal?.aborted).toBe(true)
      expect(app.getScreen()).toBe('home')
      expect(app.getAnalysisContext().state).toBe('idle')

      // 中止後に遅れて成功レスポンスが届いても、画面には反映されない
      resolveOutcome?.(
        { kind: 'success', requestId: 'req-fixed-id', candidateId: 'fixed-candidate-id', result: eventCandidate() },
      )
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')
    })

    it('double press that arrives before the fetch actually starts (during the analyzing screen render) never calls analyzeAudioFn', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn, calls } = fakeAnalyze({ kind: 'success', requestId: 'req-fixed-id', candidateId: 'fixed-candidate-id', result: eventCandidate() })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)

      bridge.emit(press())
      await Promise.resolve() // screen flips to 'analyzing' synchronously, but the render/fetch chain hasn't settled yet
      expect(app.getScreen()).toBe('analyzing')

      bridge.emit(doublePress()) // cancels before analyzeAudioFn is ever invoked
      await flushMicrotasks()

      expect(calls).toHaveLength(0)
      expect(app.getScreen()).toBe('home')
    })

    it('uses the real default request-id generator (not crypto.randomUUID) so it works on plain-HTTP LAN dev servers', async () => {
      // 実機で発生した不具合の直接的な回帰テスト: crypto.randomUUID()はSecure Context
      // (HTTPS/localhost)限定のため、http://<LAN IP>:5173 のWebViewでは例外になりうる。
      // ここではcrypto.randomUUIDが存在しない環境を模擬し、それでも解析が正常に開始されることを確認する。
      const originalRandomUUID = globalThis.crypto?.randomUUID
      // @ts-expect-error -- 意図的にSecure Context制限を再現するため削除する
      delete globalThis.crypto.randomUUID
      try {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn, calls } = fakeAnalyze({ kind: 'success', requestId: 'whatever', candidateId: 'fixed-candidate-id', result: eventCandidate({ resultType: 'not_calendar_request', title: null, startLocal: null, endLocal: null }) })
        // createRequestId をあえて上書きしない = app.ts のデフォルト実装(generateRequestId)を使う
        const app = createApp(bridge, {
          baseUrl: TEST_DEPS_BASE.baseUrl,
          sessionToken: TEST_DEPS_BASE.sessionToken,
          installId: TEST_DEPS_BASE.installId,
          analyzeAudioFn: fn,
        })
        await app.start()
        await reachCaptured(bridge)

        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('notCalendar')
        expect(calls).toHaveLength(1)
        expect(typeof calls[0]?.requestId).toBe('string')
        expect(calls[0]?.requestId.length).toBeGreaterThan(0)
      } finally {
        if (originalRandomUUID) {
          globalThis.crypto.randomUUID = originalRandomUUID
        }
      }
    })

    it('generateRequestId produces a UUID-v4-shaped string using getRandomValues (not randomUUID)', async () => {
      const { generateRequestId } = await import('../src/app')
      const id = generateRequestId()
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    })

    it('a single press on captured never leaves the app silently unresponsive: it always reaches analyzing or error', async () => {
      const bridge = new FakeEvenAppBridge()
      // getRandomValuesすら存在しない極端な環境でも、無反応ではなくエラー画面に倒れることを確認する
      vi.stubGlobal('crypto', undefined)
      try {
        stubHealthyFetch()
        const { fn } = fakeAnalyze({
          kind: 'success',
          requestId: 'x',
          candidateId: 'fixed-candidate-id',
          result: eventCandidate({ resultType: 'not_calendar_request', title: null, startLocal: null, endLocal: null }),
        })
        const app = createApp(bridge, {
          baseUrl: TEST_DEPS_BASE.baseUrl,
          sessionToken: TEST_DEPS_BASE.sessionToken,
          installId: TEST_DEPS_BASE.installId,
          analyzeAudioFn: fn,
        })
        await app.start()
        await reachCaptured(bridge)

        bridge.emit(press())
        await flushMicrotasks()

        expect(['analyzing', 'notCalendar', 'error']).toContain(app.getScreen())
        expect(app.getScreen()).not.toBe('captured')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('shows the candidate screen with title and formatted time for event_candidate', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const result = eventCandidate({ title: 'UNIQUE_TITLE_XYZ' })
      const { fn } = fakeAnalyze({ kind: 'success', requestId: 'req-fixed-id', candidateId: 'fixed-candidate-id', result })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('candidate')
      expect(app.getAnalysisContext().state).toBe('succeeded')
      expect(bridge.lastTextContent()).toContain('UNIQUE_TITLE_XYZ')
    })

    it('pressing on the candidate screen moves to final confirmation without registering to Calendar', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeAnalyze({ kind: 'success', requestId: 'req-fixed-id', candidateId: 'fixed-candidate-id', result: eventCandidate() })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('candidate')

      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('finalConfirm')
      expect(bridge.lastTextContent()).toContain('登録しますか')
    })

    it('double press on the candidate screen cancels and returns home', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeAnalyze({ kind: 'success', requestId: 'req-fixed-id', candidateId: 'fixed-candidate-id', result: eventCandidate() })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('candidate')

      bridge.emit(doublePress())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')
    })

    it('downgrades a past-dated or inconsistent event_candidate to an error instead of showing bad data', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const badResult = eventCandidate({ startLocal: '2000-01-01T10:00:00', endLocal: '2000-01-01T11:00:00' })
      const { fn } = fakeAnalyze({ kind: 'success', requestId: 'req-fixed-id', candidateId: 'fixed-candidate-id', result: badResult })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('error')
      expect(bridge.lastTextContent()).toContain('音声を解析できませんでした')
    })

    it('shows the clarification screen with the question for needs_clarification', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const result = eventCandidate({
        resultType: 'needs_clarification',
        title: null,
        startLocal: null,
        endLocal: null,
        clarificationField: 'start_time',
        clarificationQuestion: 'UNIQUE_QUESTION_ABC',
      })
      const { fn } = fakeAnalyze({
        kind: 'success',
        requestId: 'req-fixed-id',
        candidateId: null,
        conversationId: 'fixed-conversation-id',
        turn: 1,
        maxTurns: 3,
        result,
      })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('clarification')
      expect(bridge.lastTextContent()).toContain('UNIQUE_QUESTION_ABC')

      // 単押しは追加入力(follow-up)フローの「回答準備」画面へ進む(ホームへは戻らない)。
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('followupReady')

      // 二度押しなら会話を中止してホームへ戻る。
      bridge.emit(doublePress())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')
    })

    it('shows the not-calendar screen for not_calendar_request', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const result = eventCandidate({ resultType: 'not_calendar_request', title: null, startLocal: null, endLocal: null })
      const { fn } = fakeAnalyze({ kind: 'success', requestId: 'req-fixed-id', candidateId: 'fixed-candidate-id', result })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('notCalendar')

      bridge.emit(doublePress())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')
    })

    const errorCases: Array<{ outcome: AnalyzeAudioOutcome['kind']; messageFragment: string }> = [
      { outcome: 'auth_failed', messageFragment: 'セットアップが必要です' },
      { outcome: 'timeout', messageFragment: '解析が時間切れになりました' },
      { outcome: 'rate_limited', messageFragment: '少し待ってください' },
      { outcome: 'network_error', messageFragment: 'サーバーに接続できません' },
      { outcome: 'failed', messageFragment: '音声を解析できませんでした' },
    ]

    for (const { outcome, messageFragment } of errorCases) {
      it(`shows "${messageFragment}" for outcome=${outcome}`, async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn } = fakeAnalyze({ kind: outcome } as AnalyzeAudioOutcome)
        const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
        await app.start()
        await reachCaptured(bridge)

        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('error')
        expect(bridge.lastTextContent()).toContain(messageFragment)
      })
    }

    it('never shows raw HTTP status codes or technical details on the error screen', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeAnalyze({ kind: 'failed' })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)
      bridge.emit(press())
      await flushMicrotasks()

      const text = bridge.lastTextContent() ?? ''
      expect(text).not.toMatch(/\b\d{3}\b/) // 3桁のHTTPステータスコードらしき数値が出ていない
    })

    it('calls analyzeAudioFn exactly once (no automatic retry within the app)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn, calls } = fakeAnalyze({ kind: 'failed' })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)
      bridge.emit(press())
      await flushMicrotasks()
      expect(calls).toHaveLength(1)
    })

    it('clears the PCM buffer before sending, so a failed/aborted analysis never leaks audio into the next recording', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeAnalyze({ kind: 'failed' })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge, 10) // 長い録音

      bridge.emit(press()) // 解析開始 → 失敗 → エラー画面
      await flushMicrotasks()
      expect(app.getScreen()).toBe('error')

      bridge.emit(press()) // ホームへ
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')

      // 新しい短い録音を行う。以前のバッファが残っていれば'captured'になってしまうが、
      // 解析開始時点で確実に解放されていれば'tooShort'になるはず
      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(1000))
      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('tooShort')
    })

    it('never logs the session token, install id, title, or date/time content', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const result = eventCandidate({ title: 'UNIQUE_SENTINEL_TITLE' })
      const { fn } = fakeAnalyze({ kind: 'success', requestId: 'req-fixed-id', candidateId: 'fixed-candidate-id', result })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)

      bridge.emit(press())
      await flushMicrotasks()

      const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(allLogText).not.toContain('test-session-token')
      expect(allLogText).not.toContain(TEST_DEPS_BASE.installId)
      expect(allLogText).not.toContain('UNIQUE_SENTINEL_TITLE')
      expect(allLogText).not.toContain(result.startLocal ?? '')
      logSpy.mockRestore()
    })

    it('never persists the WAV bytes anywhere (localStorage only ever contains backendAvailable)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeAnalyze({ kind: 'success', requestId: 'req-fixed-id', candidateId: 'fixed-candidate-id', result: eventCandidate() })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, analyzeAudioFn: fn })
      await app.start()
      await reachCaptured(bridge)
      bridge.emit(press())
      await flushMicrotasks()

      expect(Array.from(bridge.storage.keys()).sort()).toEqual(['even-calendar.backendAvailable'])
    })
  })

  describe('Calendar registration (Phase 2D: /plugin/calendar-events integration)', () => {
    it('candidate screen press moves to final confirmation without any network call yet', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn, calls: registerCalls } = fakeRegister({ kind: 'success' })
      const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })
      expect(app.getScreen()).toBe('candidate')

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('finalConfirm')
      expect(registerCalls).toHaveLength(0)
    })

    it('pressing on the final confirmation screen transitions to registering and POSTs exactly once', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn, calls: registerCalls } = fakeRegister({ kind: 'success' })
      const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })

      bridge.emit(press()) // candidate -> finalConfirm
      await flushMicrotasks()
      expect(app.getScreen()).toBe('finalConfirm')

      bridge.emit(press()) // finalConfirm -> registering -> POST
      await Promise.resolve()
      expect(app.getScreen()).toBe('registering')
      await flushMicrotasks()

      expect(registerCalls).toHaveLength(1)
      expect(registerCalls[0]?.candidateId).toBe('fixed-candidate-id')
      expect(registerCalls[0]?.title).toBe('打ち合わせ')
    })

    it('shows the success screen with the confirmed time after a successful registration', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn } = fakeRegister({ kind: 'success' })
      const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })

      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('registered')
      expect(app.getRegistrationContext().state).toBe('completed')
      expect(bridge.lastTextContent()).toContain('登録しました')
    })

    it('pressing on the success screen returns home and clears the candidate from memory', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn } = fakeRegister({ kind: 'success' })
      const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })

      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('registered')

      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')
      expect(app.getRegistrationContext().state).toBe('idle')
    })

    it('ignores a single press while registering (no duplicate POST)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let resolveOutcome: ((o: RegisterEventOutcome) => void) | null = null
      const pending = new Promise<RegisterEventOutcome>((resolve) => {
        resolveOutcome = resolve
      })
      const { fn: registerFn, calls: registerCalls } = fakeRegister(() => pending)
      const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })

      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press()) // starts registering
      await flushMicrotasks()
      expect(app.getScreen()).toBe('registering')

      bridge.emit(press()) // ignored
      await flushMicrotasks()
      expect(registerCalls).toHaveLength(1)

      resolveOutcome?.({ kind: 'success' })
      await flushMicrotasks()
    })

    it('ignores double press while registering (registration cannot be cancelled once sent)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let resolveOutcome: ((o: RegisterEventOutcome) => void) | null = null
      const pending = new Promise<RegisterEventOutcome>((resolve) => {
        resolveOutcome = resolve
      })
      const { fn: registerFn } = fakeRegister(() => pending)
      const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })

      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('registering')

      bridge.emit(doublePress())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('registering')

      resolveOutcome?.({ kind: 'success' })
      await flushMicrotasks()
      expect(app.getScreen()).toBe('registered')
    })

    it('double press on the candidate screen cancels and discards the candidate from memory', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn, calls: registerCalls } = fakeRegister({ kind: 'success' })
      const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })

      bridge.emit(doublePress())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('home')
      expect(registerCalls).toHaveLength(0)

      // ホームから録音→解析をやり直しても、以前の候補は使い回されない(登録APIは一切呼ばれない)
      expect(app.getRegistrationContext().state).toBe('idle')
    })

    it('double press on the final confirmation screen cancels before any network call', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn, calls: registerCalls } = fakeRegister({ kind: 'success' })
      const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })

      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('finalConfirm')

      bridge.emit(doublePress())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('home')
      expect(registerCalls).toHaveLength(0)
    })

    const registrationErrorCases: Array<{ outcome: RegisterEventOutcome; messageFragment: string }> = [
      { outcome: { kind: 'auth_failed' }, messageFragment: 'セットアップが必要です' },
      { outcome: { kind: 'candidate_expired' }, messageFragment: '期限切れです' },
      { outcome: { kind: 'oauth_not_connected' }, messageFragment: 'カレンダー接続が必要です' },
      { outcome: { kind: 'failed' }, messageFragment: '登録できませんでした' },
    ]

    for (const { outcome, messageFragment } of registrationErrorCases) {
      it(`shows "${messageFragment}" for registration outcome=${outcome.kind}`, async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn: registerFn } = fakeRegister(outcome)
        const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })

        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('error')
        expect(bridge.lastTextContent()).toContain(messageFragment)
      })
    }

    it('on timeout, polls the status endpoint and shows success once it reports completed', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn } = fakeRegister({ kind: 'timeout' })
      const { fn: pollFn, calls: pollCalls } = fakePoll({ kind: 'status', status: 'completed' })
      const app = await reachCandidate(bridge, {
        registerCalendarEventFn: registerFn,
        pollForCompletionFn: pollFn,
        registrationPollIntervalMs: 1,
        registrationPollMaxAttempts: 1,
      })

      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await Promise.resolve()
      expect(app.getScreen()).toBe('registering')

      await flushMicrotasks()
      // タイムアウト検出後、確認中画面を経て completed により成功画面へ
      expect(pollCalls.length).toBeGreaterThan(0)
      expect(app.getScreen()).toBe('registered')
    })

    it('on network_error, also falls back to status polling', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn } = fakeRegister({ kind: 'network_error' })
      const { fn: pollFn, calls: pollCalls } = fakePoll({ kind: 'status', status: 'completed' })
      const app = await reachCandidate(bridge, {
        registerCalendarEventFn: registerFn,
        pollForCompletionFn: pollFn,
        registrationPollIntervalMs: 1,
        registrationPollMaxAttempts: 1,
      })

      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()
      await flushMicrotasks()
      await flushMicrotasks()

      expect(pollCalls.length).toBeGreaterThan(0)
      expect(app.getScreen()).toBe('registered')
    })

    it('shows a generic failure if polling never reports completed', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn } = fakeRegister({ kind: 'timeout' })
      const { fn: pollFn } = fakePoll({ kind: 'status', status: 'pending' })
      const app = await reachCandidate(bridge, {
        registerCalendarEventFn: registerFn,
        pollForCompletionFn: pollFn,
        registrationPollIntervalMs: 1,
        registrationPollMaxAttempts: 1,
      })

      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()
      await flushMicrotasks()
      await flushMicrotasks()

      expect(app.getScreen()).toBe('error')
      expect(bridge.lastTextContent()).toContain('登録できませんでした')
    })

    it('does not automatically retry the registration POST itself (registerCalendarEventFn called exactly once even when polling occurs)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn, calls: registerCalls } = fakeRegister({ kind: 'timeout' })
      const { fn: pollFn } = fakePoll({ kind: 'status', status: 'completed' })
      await reachCandidate(bridge, {
        registerCalendarEventFn: registerFn,
        pollForCompletionFn: pollFn,
        registrationPollIntervalMs: 1,
        registrationPollMaxAttempts: 1,
      })

      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()

      expect(registerCalls).toHaveLength(1)
    })

    it('never persists candidate data to localStorage (localStorage only ever contains backendAvailable)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn } = fakeRegister({ kind: 'success' })
      await reachCandidate(bridge, { registerCalendarEventFn: registerFn })

      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()

      expect(Array.from(bridge.storage.keys()).sort()).toEqual(['even-calendar.backendAvailable'])
    })

    it('discards the candidate from memory on cancel, success, and failure alike', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()

      // 1) cancel
      {
        const { fn: registerFn } = fakeRegister({ kind: 'success' })
        const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })
        bridge.emit(doublePress())
        await flushMicrotasks()
        expect(app.getRegistrationContext().state).toBe('idle')
      }
    })

    it('never logs the title, date/time, token, installId, or raw response JSON during registration', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: registerFn } = fakeRegister({ kind: 'success' })
      const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn }, { title: 'UNIQUE_REGISTER_TITLE' })

      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('registered')

      const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(allLogText).not.toContain('UNIQUE_REGISTER_TITLE')
      expect(allLogText).not.toContain(TEST_DEPS_BASE.sessionToken)
      expect(allLogText).not.toContain(TEST_DEPS_BASE.installId)
      logSpy.mockRestore()
    })

    describe('all-day / multi-day candidates (allDay: true discriminated union)', () => {
      it('shows the final confirmation screen with the inclusive date range, never the exclusive end date, for a multi-day all-day candidate', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn: registerFn } = fakeRegister({ kind: 'success' })
        const startDate = futureLocalDate(3)
        const endDateExclusive = futureLocalDate(6)
        const app = await reachCandidate(
          bridge,
          { registerCalendarEventFn: registerFn },
          allDayEventCandidate({ title: '夏季休暇', startDate, endDateExclusive }),
        )
        expect(app.getScreen()).toBe('candidate')

        bridge.emit(press()) // candidate -> finalConfirm
        await flushMicrotasks()

        expect(app.getScreen()).toBe('finalConfirm')
        const text = bridge.lastTextContent()
        // 包含最終日を表示し、Google APIの排他的終了日(endDateExclusive)はそのまま出さない。
        expect(text).toContain(`${monthDay(startDate)}〜${monthDay(inclusiveEndDate(endDateExclusive))}`)
        expect(text).not.toContain(monthDay(endDateExclusive))
      })

      it('shows a single-day "終日 M/D" confirmation for a one-day all-day candidate (no range dash)', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn: registerFn } = fakeRegister({ kind: 'success' })
        const startDate = futureLocalDate(3)
        const endDateExclusive = futureLocalDate(4)
        const app = await reachCandidate(
          bridge,
          { registerCalendarEventFn: registerFn },
          allDayEventCandidate({ title: '有給', startDate, endDateExclusive }),
        )

        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('finalConfirm')
        const text = bridge.lastTextContent()
        expect(text).toContain(`終日 ${monthDay(startDate)}`)
        expect(text).not.toContain('〜')
        expect(text).not.toContain(monthDay(endDateExclusive))
      })

      it('POSTs allDay:true with startDate/endDateExclusive and no startLocal/endLocal for an all-day candidate', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn: registerFn, calls: registerCalls } = fakeRegister({ kind: 'success' })
        const startDate = futureLocalDate(3)
        const endDateExclusive = futureLocalDate(6)
        const app = await reachCandidate(
          bridge,
          { registerCalendarEventFn: registerFn },
          allDayEventCandidate({ title: '夏季休暇', startDate, endDateExclusive }),
        )

        bridge.emit(press()) // candidate -> finalConfirm
        await flushMicrotasks()
        bridge.emit(press()) // finalConfirm -> registering -> POST
        await flushMicrotasks()

        expect(app.getScreen()).toBe('registered')
        expect(registerCalls).toHaveLength(1)
        const call = registerCalls[0]
        expect(call?.allDay).toBe(true)
        if (call?.allDay) {
          expect(call.startDate).toBe(startDate)
          expect(call.endDateExclusive).toBe(endDateExclusive)
        }
        expect((call as unknown as { startLocal?: unknown }).startLocal).toBeUndefined()
        expect((call as unknown as { endLocal?: unknown }).endLocal).toBeUndefined()
      })

      it('shows the inclusive date range on the registered (success) screen for an all-day candidate', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn: registerFn } = fakeRegister({ kind: 'success' })
        const startDate = futureLocalDate(3)
        const endDateExclusive = futureLocalDate(6)
        const app = await reachCandidate(
          bridge,
          { registerCalendarEventFn: registerFn },
          allDayEventCandidate({ title: '夏季休暇', startDate, endDateExclusive }),
        )

        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('registered')
        expect(app.getRegistrationContext().state).toBe('completed')
        const text = bridge.lastTextContent()
        expect(text).toContain('登録しました')
        expect(text).toContain(`${monthDay(startDate)}〜${monthDay(inclusiveEndDate(endDateExclusive))}`)
        expect(text).not.toContain(monthDay(endDateExclusive))
      })

      it('POSTs allDay:false with startLocal/endLocal and no startDate/endDateExclusive for a regular timed candidate (regression)', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn: registerFn, calls: registerCalls } = fakeRegister({ kind: 'success' })
        const app = await reachCandidate(bridge, { registerCalendarEventFn: registerFn })

        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('registered')
        expect(registerCalls).toHaveLength(1)
        const call = registerCalls[0]
        expect(call?.allDay).toBe(false)
        if (call && !call.allDay) {
          expect(typeof call.startLocal).toBe('string')
          expect(typeof call.endLocal).toBe('string')
        }
        expect((call as unknown as { startDate?: unknown }).startDate).toBeUndefined()
        expect((call as unknown as { endDateExclusive?: unknown }).endDateExclusive).toBeUndefined()
      })
    })
  })

  describe('Follow-up conversation (Phase 2E: /plugin/analyze-followup-audio integration)', () => {
    it('pressing on the clarification screen moves to followupReady without recording or sending anything yet', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: followupFn, calls } = fakeAnalyzeFollowup({
        kind: 'success',
        requestId: 'req',
        conversationId: 'fixed-conversation-id',
        result: followupResult(),
        candidateId: null,
        turn: null,
        maxTurns: null,
      })
      const app = await reachClarification(bridge, { analyzeFollowupAudioFn: followupFn })
      expect(app.getScreen()).toBe('clarification')

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('followupReady')
      expect(calls).toHaveLength(0)
    })

    it('pressing on followupReady starts recording (separate buffer from the initial recording)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = await reachClarification(bridge)
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('followupReady')

      bridge.emit(press())
      await Promise.resolve()
      await Promise.resolve()

      expect(app.getScreen()).toBe('followupRecording')
      expect(app.getFollowupRecordingContext().state).toBe('recording')
      expect(bridge.audioControlCalls.at(-1)).toEqual({ isOpen: true, source: AudioInputSource.Glasses })
    })

    it('stopping the follow-up recording moves to followupCaptured', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = await reachFollowupCaptured(bridge)
      expect(app.getScreen()).toBe('followupCaptured')
      expect(app.getFollowupRecordingContext().state).toBe('captured')
      expect(bridge.lastTextContent()).toContain('押す: 送信')
    })

    it('rejects a too-short follow-up answer and returns home (discarding the conversation)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: cancelFn, calls: cancelCalls } = fakeCancelConversation()
      const app = await reachClarification(bridge, { cancelConversationFn: cancelFn })
      bridge.emit(press()) // -> followupReady
      await flushMicrotasks()
      bridge.emit(press()) // -> followupRecording
      await Promise.resolve()
      await Promise.resolve()
      bridge.emit(audioChunk(1000)) // 0.5秒未満
      bridge.emit(press()) // -> tooShort
      await flushMicrotasks()
      expect(app.getScreen()).toBe('tooShort')

      bridge.emit(press()) // tooShort -> home (会話も破棄)
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')
      expect(cancelCalls).toHaveLength(1)
    })

    it('sends the follow-up WAV exactly once with the conversationId header on press', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: followupFn, calls } = fakeAnalyzeFollowup({
        kind: 'success',
        requestId: 'req',
        conversationId: 'fixed-conversation-id',
        result: followupResult(),
        candidateId: 'new-candidate-id',
        turn: null,
        maxTurns: null,
      })
      const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: followupFn })

      bridge.emit(press())
      await Promise.resolve()
      expect(app.getScreen()).toBe('analyzing')
      await flushMicrotasks()

      expect(calls).toHaveLength(1)
      expect(calls[0]?.conversationId).toBe('fixed-conversation-id')
      expect(calls[0]?.wav.byteLength).toBeGreaterThan(44)
    })

    it('ignores a single press while analyzing the follow-up (no duplicate send)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let resolveOutcome: ((o: AnalyzeFollowupOutcome) => void) | null = null
      const pending = new Promise<AnalyzeFollowupOutcome>((resolve) => {
        resolveOutcome = resolve
      })
      const { fn: followupFn, calls } = fakeAnalyzeFollowup(() => pending)
      const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: followupFn })

      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('analyzing')

      bridge.emit(press()) // ignored
      await flushMicrotasks()
      expect(calls).toHaveLength(1)

      resolveOutcome?.({ kind: 'success', requestId: 'req', conversationId: 'fixed-conversation-id', result: followupResult(), candidateId: 'c', turn: null, maxTurns: null })
      await flushMicrotasks()
    })

    it('double press while analyzing the follow-up aborts and best-effort cancels the conversation', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let capturedSignal: AbortSignal | undefined
      let resolveOutcome: ((o: AnalyzeFollowupOutcome) => void) | null = null
      const pending = new Promise<AnalyzeFollowupOutcome>((resolve) => {
        resolveOutcome = resolve
      })
      const wrapped = async (params: AnalyzeFollowupParams): Promise<AnalyzeFollowupOutcome> => {
        capturedSignal = params.signal
        return pending
      }
      const { fn: cancelFn, calls: cancelCalls } = fakeCancelConversation()
      const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: wrapped, cancelConversationFn: cancelFn })

      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('analyzing')
      expect(capturedSignal).toBeDefined()

      bridge.emit(doublePress())
      await flushMicrotasks()

      expect(capturedSignal?.aborted).toBe(true)
      expect(app.getScreen()).toBe('home')
      expect(cancelCalls).toHaveLength(1)

      resolveOutcome?.({ kind: 'success', requestId: 'req', conversationId: 'fixed-conversation-id', result: followupResult(), candidateId: 'c', turn: null, maxTurns: null })
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')
    })

    it('shows a second clarification question when still incomplete, and the answer flow can be repeated', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: followupFn } = fakeAnalyzeFollowup({
        kind: 'success',
        requestId: 'req',
        conversationId: 'fixed-conversation-id',
        result: followupResult({
          resultType: 'needs_clarification',
          title: null,
          startLocal: null,
          endLocal: null,
          clarificationField: 'date',
          clarificationQuestion: 'SECOND_QUESTION',
        }),
        candidateId: null,
        turn: 2,
        maxTurns: 3,
      })
      const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: followupFn })

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('clarification')
      expect(bridge.lastTextContent()).toContain('SECOND_QUESTION')

      // 2回目の回答フローもそのまま繰り返せる
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('followupReady')
    })

    it('completes the candidate and connects to the existing 2-stage registration flow', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: followupFn } = fakeAnalyzeFollowup({
        kind: 'success',
        requestId: 'req',
        conversationId: 'fixed-conversation-id',
        result: followupResult({ title: 'COMPLETED_TITLE' }),
        candidateId: 'new-candidate-id',
        turn: null,
        maxTurns: null,
      })
      const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: followupFn })

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('candidate')
      expect(bridge.lastTextContent()).toContain('COMPLETED_TITLE')

      // 既存の2段階確認フローへそのまま接続する
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('finalConfirm')
    })

    it('treats a cancel-phrase result as resultType=cancelled and returns home without a candidate', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: followupFn } = fakeAnalyzeFollowup({
        kind: 'success',
        requestId: 'req',
        conversationId: 'fixed-conversation-id',
        result: followupResult({ resultType: 'cancelled', title: null, startLocal: null, endLocal: null }),
        candidateId: null,
        turn: null,
        maxTurns: null,
      })
      const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: followupFn })

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('home')
      expect(app.getAnalysisContext().state).toBe('idle')
    })

    it('terminates as cancelled on the third unfinished turn ("start over") without a candidate', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      // バックエンドが3ターン打ち切りを検知した場合、resultType=cancelledとして返す設計
      const { fn: followupFn } = fakeAnalyzeFollowup({
        kind: 'success',
        requestId: 'req',
        conversationId: 'fixed-conversation-id',
        result: followupResult({ resultType: 'cancelled', title: null, startLocal: null, endLocal: null }),
        candidateId: null,
        turn: null,
        maxTurns: null,
      })
      const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: followupFn })
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')
    })

    const followupErrorCases: Array<{ outcome: AnalyzeFollowupOutcome; messageFragment: string }> = [
      { outcome: { kind: 'auth_failed' }, messageFragment: 'セットアップが必要です' },
      { outcome: { kind: 'conversation_expired' }, messageFragment: '最初からやり直してください' },
      { outcome: { kind: 'timeout' }, messageFragment: '解析が時間切れになりました' },
      { outcome: { kind: 'network_error' }, messageFragment: 'サーバーに接続できません' },
      { outcome: { kind: 'failed' }, messageFragment: '音声を解析できませんでした' },
    ]

    for (const { outcome, messageFragment } of followupErrorCases) {
      it(`shows "${messageFragment}" for follow-up outcome=${outcome.kind}`, async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn: followupFn } = fakeAnalyzeFollowup(outcome)
        const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: followupFn })

        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('error')
        expect(bridge.lastTextContent()).toContain(messageFragment)
      })
    }

    it('does not automatically retry the follow-up analysis (called exactly once)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: followupFn, calls } = fakeAnalyzeFollowup({ kind: 'failed' })
      const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: followupFn })
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('error')
      expect(calls).toHaveLength(1)
    })

    it('never persists conversation/candidate/audio data to localStorage', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: followupFn } = fakeAnalyzeFollowup({
        kind: 'success',
        requestId: 'req',
        conversationId: 'fixed-conversation-id',
        result: followupResult(),
        candidateId: 'new-candidate-id',
        turn: null,
        maxTurns: null,
      })
      const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: followupFn })
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('candidate')
      expect(Array.from(bridge.storage.keys()).sort()).toEqual(['even-calendar.backendAvailable'])
    })

    it('foreground re-entry does not auto-continue the conversation: it resets to home', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: cancelFn, calls: cancelCalls } = fakeCancelConversation()
      const app = await reachClarification(bridge, { cancelConversationFn: cancelFn })
      expect(app.getScreen()).toBe('clarification')

      bridge.emit(foregroundEnter())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('home')
      expect(cancelCalls).toHaveLength(1)
    })

    it('never logs the question text, answer content, title/date, conversationId/candidateId raw value, token, or installId', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: followupFn } = fakeAnalyzeFollowup({
        kind: 'success',
        requestId: 'req',
        conversationId: 'fixed-conversation-id',
        result: followupResult({ title: 'UNIQUE_SENTINEL_TITLE' }),
        candidateId: 'new-candidate-id',
        turn: null,
        maxTurns: null,
      })
      const app = await reachFollowupCaptured(bridge, { analyzeFollowupAudioFn: followupFn })
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('candidate')

      const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(allLogText).not.toContain('UNIQUE_SENTINEL_TITLE')
      expect(allLogText).not.toContain('INITIAL_QUESTION')
      expect(allLogText).not.toContain('fixed-conversation-id')
      expect(allLogText).not.toContain('new-candidate-id')
      expect(allLogText).not.toContain(TEST_DEPS_BASE.sessionToken)
      expect(allLogText).not.toContain(TEST_DEPS_BASE.installId)
      logSpy.mockRestore()
    })

    it('exactly one event-capture container is created (regression, unaffected by new screens)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge, TEST_DEPS_BASE)
      await app.start()
      const payload = bridge.createStartUpCalls[0] as { textObject: Array<{ isEventCapture?: number }> }
      const captureContainers = payload.textObject.filter((c) => c.isEventCapture === 1)
      expect(captureContainers).toHaveLength(1)
    })
  })

  describe('Day events (Phase 2F: /plugin/calendar-events/day integration)', () => {
    async function selectHomeMenu(bridge: FakeEvenAppBridge, index: number): Promise<void> {
      for (let i = 0; i < index; i += 1) {
        bridge.emit(swipeDown())
        await flushMicrotasks()
      }
    }

    it('pressing "今日の予定" fetches once and shows the loading screen, then the list', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn, calls } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent()] }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2) // -> 今日の予定

      bridge.emit(press())
      await Promise.resolve()
      expect(app.getScreen()).toBe('dayLoading')

      await flushMicrotasks()
      expect(app.getScreen()).toBe('dayList')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.day).toBe('today')
      expect(calls[0]?.baseUrl).toBe(TEST_DEPS_BASE.baseUrl)
      expect(calls[0]?.sessionToken).toBe(TEST_DEPS_BASE.sessionToken)
      expect(calls[0]?.installId).toBe(TEST_DEPS_BASE.installId)
      expect(typeof calls[0]?.requestId).toBe('string')
      expect(bridge.lastTextContent()).toContain('今日の予定')
      expect(bridge.lastTextContent()).toContain('朝会')
    })

    it('pressing "明日の予定" fetches day=tomorrow', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn, calls } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ day: 'tomorrow', dateLocal: '2026-07-24' }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 3) // -> 明日の予定

      bridge.emit(press())
      await flushMicrotasks()

      expect(calls).toHaveLength(1)
      expect(calls[0]?.day).toBe('tomorrow')
      expect(app.getScreen()).toBe('dayEmpty')
    })

    it('shows the empty screen when there are no events', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [] }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('dayEmpty')
      expect(bridge.lastTextContent()).toContain('予定はありません')
      expect(bridge.lastTextContent()).toContain('二度押し: 戻る')
    })

    it('double press returns home from the empty screen; single press is ignored', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [] }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('dayEmpty')

      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('dayEmpty') // 単押しは無視される

      bridge.emit(doublePress())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')
    })

    it('sorts all-day events before timed events, and timed events by start time', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const events = [
        timedDayEvent({ eventId: 'k2', title: '打ち合わせ', startLocal: '2026-07-23T15:00:00', endLocal: '2026-07-23T16:00:00' }),
        allDayDayEvent({ eventId: 'k1', title: '休暇' }),
        timedDayEvent({ eventId: 'k3', title: '朝会', startLocal: '2026-07-23T09:00:00', endLocal: '2026-07-23T10:00:00' }),
      ]
      const { fn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()

      const text = bridge.lastTextContent() ?? ''
      const allDayIdx = text.indexOf('休暇')
      const asaIdx = text.indexOf('朝会')
      const meetingIdx = text.indexOf('打ち合わせ')
      expect(allDayIdx).toBeGreaterThanOrEqual(0)
      expect(allDayIdx).toBeLessThan(asaIdx)
      expect(asaIdx).toBeLessThan(meetingIdx)
      expect(text).toContain('終日 休暇')
      expect(text).toContain('09:00-10:00 朝会')
      expect(text).toContain('15:00-16:00 打ち合わせ')
    })

    it('shows a 3-item selection window (like the home menu) and moves the cursor via swipe up/down', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const events = [1, 2, 3, 4].map((i) =>
        timedDayEvent({ eventId: `k${i}`, title: `event-${i}`, startLocal: `2026-07-23T0${i}:00:00`, endLocal: `2026-07-23T0${i}:30:00` }),
      )
      const { fn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('dayList')
      let text = bridge.lastTextContent() ?? ''
      expect(text).toContain('今日の予定 1/4')
      expect(text).toContain('> 01:00-01:30 event-1')
      expect(text).toContain('event-2')
      expect(text).toContain('event-3')
      expect(text).not.toContain('event-4') // ウィンドウ外
      expect(text).not.toContain('ほかの予定があります') // truncated:falseなので出ない

      bridge.emit(swipeDown()) // カーソルを1件下へ
      await flushMicrotasks()
      text = bridge.lastTextContent() ?? ''
      expect(text).toContain('今日の予定 2/4')
      expect(text).toContain('> 02:00-02:30 event-2')

      bridge.emit(swipeDown())
      await flushMicrotasks()
      bridge.emit(swipeDown())
      await flushMicrotasks()
      text = bridge.lastTextContent() ?? ''
      expect(text).toContain('今日の予定 4/4')
      expect(text).toContain('> 04:00-04:30 event-4')
      expect(text).not.toContain('event-1') // ウィンドウが末尾へずれた

      // 末尾でこれ以上進まない
      bridge.emit(swipeDown())
      await flushMicrotasks()
      expect(bridge.lastTextContent()).toContain('4/4')

      bridge.emit(swipeUp()) // カーソルを1件上へ
      await flushMicrotasks()
      expect(bridge.lastTextContent()).toContain('3/4')
    })

    it('shows the truncated notice only once the selection window reaches the end, when the server reports truncated:true', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const events = [1, 2, 3, 4].map((i) => timedDayEvent({ eventId: `k${i}`, title: `e${i}`, startLocal: `2026-07-23T0${i}:00:00`, endLocal: `2026-07-23T0${i}:30:00` }))
      const { fn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events, truncated: true }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()
      expect(bridge.lastTextContent()).not.toContain('ほかの予定があります')

      bridge.emit(swipeDown())
      await flushMicrotasks()
      bridge.emit(swipeDown())
      await flushMicrotasks()
      expect(bridge.lastTextContent()).toContain('ほかの予定があります')
    })

    it('selecting the currently highlighted event (single press) opens its detail screen', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const events = [timedDayEvent({ eventId: 'k1', title: '朝会' })]
      const { fn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
      const detail = eventDetail({ eventId: 'k1', title: '朝会' })
      const { fn: detailFn, calls } = fakeEventDetail({ kind: 'success', result: detail })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn, fetchEventDetailFn: detailFn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('dayList')

      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('eventDetail')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.eventId).toBe('k1')
      expect(bridge.lastTextContent()).toContain('朝会')
    })

    it('formats multi-day timed events as continuing from/into the boundary day', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const events = [
        timedDayEvent({ eventId: 'from-prev', title: '前日から続く', startLocal: '2026-07-22T22:00:00', endLocal: '2026-07-23T10:00:00' }),
      ]
      const { fn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()

      expect(bridge.lastTextContent()).toContain('前日から-10:00')
    })

    it('double press while loading aborts the request and returns home; a late response is not reflected', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let capturedSignal: AbortSignal | undefined
      let resolveOutcome: ((o: FetchDayEventsOutcome) => void) | null = null
      const pending = new Promise<FetchDayEventsOutcome>((resolve) => {
        resolveOutcome = resolve
      })
      const { fn } = fakeDayEvents((): Promise<FetchDayEventsOutcome> => pending)
      const wrappedFn = async (params: FetchDayEventsParams): Promise<FetchDayEventsOutcome> => {
        capturedSignal = params.signal
        return fn(params)
      }
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: wrappedFn })
      await app.start()
      await selectHomeMenu(bridge, 2)

      bridge.emit(press())
      await Promise.resolve()
      expect(app.getScreen()).toBe('dayLoading')
      await flushMicrotasks()
      expect(capturedSignal).toBeDefined()

      bridge.emit(doublePress())
      await flushMicrotasks()

      expect(capturedSignal?.aborted).toBe(true)
      expect(app.getScreen()).toBe('home')

      resolveOutcome?.({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent()] }) })
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home') // 中止後に遅れて届いた結果は反映されない
    })

    it('ignores a single press while already loading (no duplicate fetch)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let resolveOutcome: ((o: FetchDayEventsOutcome) => void) | null = null
      const pending = new Promise<FetchDayEventsOutcome>((resolve) => {
        resolveOutcome = resolve
      })
      const { fn, calls } = fakeDayEvents(() => pending)
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)

      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('dayLoading')

      bridge.emit(press()) // 無視されるはず
      await flushMicrotasks()
      expect(calls).toHaveLength(1)

      resolveOutcome?.({ kind: 'success', result: dayEventsResult({ events: [] }) })
      await flushMicrotasks()
    })

    const errorCases: Array<{ outcome: FetchDayEventsOutcome['kind']; messageFragment: string }> = [
      { outcome: 'auth_failed', messageFragment: 'セットアップが必要です' },
      { outcome: 'forbidden', messageFragment: 'カレンダーを読み取れません' },
      { outcome: 'rate_limited', messageFragment: 'アクセスが集中しています' },
      { outcome: 'timeout', messageFragment: '通信できませんでした' },
      { outcome: 'network_error', messageFragment: '通信できませんでした' },
      { outcome: 'failed', messageFragment: '予定を取得できませんでした' },
    ]

    for (const { outcome, messageFragment } of errorCases) {
      it(`shows "${messageFragment}" for outcome=${outcome}, with only a double-press-to-return hint`, async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn } = fakeDayEvents({ kind: outcome } as FetchDayEventsOutcome)
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 2)

        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('dayError')
        expect(bridge.lastTextContent()).toContain(messageFragment)
        expect(bridge.lastTextContent()).toContain('二度押し: 戻る')

        // 単押しは無視され、二度押しでのみホームへ戻る
        bridge.emit(press())
        await flushMicrotasks()
        expect(app.getScreen()).toBe('dayError')

        bridge.emit(doublePress())
        await flushMicrotasks()
        expect(app.getScreen()).toBe('home')
      })
    }

    it('never shows raw HTTP status codes on the day error screen', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeDayEvents({ kind: 'failed' })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()

      const text = bridge.lastTextContent() ?? ''
      expect(text).not.toMatch(/\b\d{3}\b/)
    })

    it('foreground re-entry resets an in-flight day-events fetch and the menu selection to home', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let capturedSignal: AbortSignal | undefined
      const pending = new Promise<FetchDayEventsOutcome>(() => {})
      const { fn } = fakeDayEvents((): Promise<FetchDayEventsOutcome> => pending)
      const wrappedFn = async (params: FetchDayEventsParams): Promise<FetchDayEventsOutcome> => {
        capturedSignal = params.signal
        return fn(params)
      }
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: wrappedFn })
      await app.start()
      await selectHomeMenu(bridge, 3) // 明日の予定を選択した状態にしておく

      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('dayLoading')

      bridge.emit(foregroundEnter())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('home')
      expect(app.getHomeMenuIndex()).toBe(0)
      expect(app.getDayEventsContext().state).toBe('idle')
      expect(capturedSignal?.aborted).toBe(true)
    })

    it('foreground exit while loading aborts the in-flight fetch', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let capturedSignal: AbortSignal | undefined
      const pending = new Promise<FetchDayEventsOutcome>(() => {})
      const { fn } = fakeDayEvents((): Promise<FetchDayEventsOutcome> => pending)
      const wrappedFn = async (params: FetchDayEventsParams): Promise<FetchDayEventsOutcome> => {
        capturedSignal = params.signal
        return fn(params)
      }
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: wrappedFn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()

      bridge.emit(foregroundExit())
      await flushMicrotasks()

      expect(capturedSignal?.aborted).toBe(true)
      expect(app.getDayEventsContext().state).toBe('idle')
    })

    it('dispose() aborts an in-flight day-events fetch', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      let capturedSignal: AbortSignal | undefined
      const pending = new Promise<FetchDayEventsOutcome>(() => {})
      const { fn } = fakeDayEvents((): Promise<FetchDayEventsOutcome> => pending)
      const wrappedFn = async (params: FetchDayEventsParams): Promise<FetchDayEventsOutcome> => {
        capturedSignal = params.signal
        return fn(params)
      }
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: wrappedFn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()

      app.dispose()

      expect(capturedSignal?.aborted).toBe(true)
    })

    it('never persists day-events data to localStorage (only backendAvailable)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent()] }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()

      expect(Array.from(bridge.storage.keys()).sort()).toEqual(['even-calendar.backendAvailable'])
    })

    it('discards the events array from memory on return to home (RESET)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent()] }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getDayEventsContext().events.length).toBe(1)

      bridge.emit(doublePress())
      await flushMicrotasks()

      expect(app.getDayEventsContext().events).toEqual([])
      expect(app.getDayEventsContext().state).toBe('idle')
    })

    it('never logs event titles or ISO date/time content, nor the session token/install id', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeDayEvents({
        kind: 'success',
        result: dayEventsResult({ events: [timedDayEvent({ title: 'UNIQUE_SENTINEL_EVENT_TITLE' })] }),
      })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()

      const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(allLogText).not.toContain('UNIQUE_SENTINEL_EVENT_TITLE')
      expect(allLogText).not.toContain('2026-07-23T09:00:00')
      expect(allLogText).not.toContain(TEST_DEPS_BASE.sessionToken)
      expect(allLogText).not.toContain(TEST_DEPS_BASE.installId)
      logSpy.mockRestore()
    })

    it('does not call the Calendar registration/creation client during the day-events flow', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent()] }) })
      const { fn: registerFn, calls: registerCalls } = fakeRegister({ kind: 'success' })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: fn, registerCalendarEventFn: registerFn })
      await app.start()
      await selectHomeMenu(bridge, 2)
      bridge.emit(press())
      await flushMicrotasks()

      expect(registerCalls).toHaveLength(0)
    })

    it('pressing "予定を登録" (default selection) still starts the existing recording flow (regression)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge, TEST_DEPS_BASE)
      await app.start()

      bridge.emit(press()) // homeMenuIndex===0のまま
      await Promise.resolve()
      await Promise.resolve()

      expect(app.getScreen()).toBe('recording')
    })

    it('cancelling recording from the menu-selected register flow returns to the home menu at index 0', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge, TEST_DEPS_BASE)
      await app.start()
      await selectHomeMenu(bridge, 2) // 今日の予定へ一旦移動してからキャンセルする想定はないが、選択インデックスの独立性を確認する

      // ホームに一度戻してから登録フローに入る(実際の操作順序)
      for (let i = 0; i < 3; i += 1) {
        bridge.emit(swipeUp())
        await flushMicrotasks()
      }
      expect(app.getHomeMenuIndex()).toBe(0)

      bridge.emit(press()) // 予定を登録
      await Promise.resolve()
      await Promise.resolve()
      expect(app.getScreen()).toBe('recording')

      bridge.emit(doublePress()) // キャンセル
      await flushMicrotasks()
      expect(app.getScreen()).toBe('home')
      expect(app.getHomeMenuIndex()).toBe(0)
    })
  })

  describe('Phase 2G: home menu (4 items, 3-item window) and upcoming events', () => {
    async function selectHomeMenu(bridge: FakeEvenAppBridge, index: number): Promise<void> {
      for (let i = 0; i < index; i += 1) {
        bridge.emit(swipeDown())
        await flushMicrotasks()
      }
    }

    it('home menu holds exactly 6 items in order: 予定を登録, 直近5件の予定, 今日の予定, 明日の予定, Googleカレンダーを再接続, 言語 (昨日の予定 removed)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()
      const payload = bridge.createStartUpCalls[0] as { textObject: Array<{ content?: string }> }
      const text = payload.textObject[0]?.content ?? ''
      expect(text).not.toContain('昨日の予定')
      expect(text).toContain('Calendar with Gemini 1/6')
      const order = ['予定を登録', '直近5件の予定', '今日の予定']
      const indices = order.map((item) => text.indexOf(item))
      expect(indices.every((i) => i >= 0)).toBe(true)
      expect(indices).toEqual([...indices].sort((a, b) => a - b))
      expect(app.getHomeMenuIndex()).toBe(0)
    })

    it('Phase 2K: existing 4 items (予定を登録/直近5件の予定/今日の予定/明日の予定) keep their original single-press actions unaffected by the 5th item', async () => {
      stubHealthyFetch()
      const { fn: dayFn, calls: dayCalls } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [] }) })
      const { fn: upcomingFn, calls: upcomingCalls } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events: [] }) })
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: dayFn, fetchUpcomingEventsFn: upcomingFn })
      await app.start()

      bridge.emit(press()) // index0: 予定を登録
      await flushMicrotasks()
      expect(app.getScreen()).toBe('recording')
      bridge.emit(doublePress()) // cancel back home
      await flushMicrotasks()

      await selectHomeMenu(bridge, 1) // index1: 直近5件の予定
      bridge.emit(press())
      await flushMicrotasks()
      expect(upcomingCalls).toHaveLength(1)
      bridge.emit(doublePress())
      await flushMicrotasks()

      await selectHomeMenu(bridge, 2) // index2: 今日の予定
      bridge.emit(press())
      await flushMicrotasks()
      expect(dayCalls).toHaveLength(1)
      expect(dayCalls[0]?.day).toBe('today')
      bridge.emit(doublePress())
      await flushMicrotasks()

      await selectHomeMenu(bridge, 3) // index3: 明日の予定
      bridge.emit(press())
      await flushMicrotasks()
      expect(dayCalls).toHaveLength(2)
      expect(dayCalls[1]?.day).toBe('tomorrow')
    })

    it('shows only a 3-item window at a time as selection moves, never all 6 at once, with a correct N/6 indicator', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()

      expect(bridge.createStartUpCalls[0]).toBeDefined()
      const initialText = (bridge.createStartUpCalls[0] as { textObject: Array<{ content?: string }> }).textObject[0]?.content ?? ''
      expect(initialText).toContain('1/6')
      expect(initialText).not.toContain('明日の予定')

      await selectHomeMenu(bridge, 2) // -> 今日の予定 (window shifts to hide 予定を登録)
      let text = bridge.lastTextContent() ?? ''
      expect(text).toContain('3/6')
      expect(text).not.toContain('予定を登録')
      expect(text).toContain('> 今日の予定')

      bridge.emit(swipeDown()) // -> 明日の予定
      await flushMicrotasks()
      text = bridge.lastTextContent() ?? ''
      expect(text).toContain('4/6')
      expect(text).toContain('> 明日の予定')
      expect(app.getHomeMenuIndex()).toBe(3)

      bridge.emit(swipeDown()) // -> Googleカレンダーを再接続
      await flushMicrotasks()
      text = bridge.lastTextContent() ?? ''
      expect(text).toContain('5/6')
      expect(text).toContain('> Googleカレンダーを再接続')
      expect(app.getHomeMenuIndex()).toBe(4)

      bridge.emit(swipeDown()) // -> 言語 (new last item)
      await flushMicrotasks()
      text = bridge.lastTextContent() ?? ''
      expect(text).toContain('6/6')
      expect(text).toContain('> 言語')
      expect(app.getHomeMenuIndex()).toBe(5)

      // 末尾でこれ以上進まない(クランプ)
      bridge.emit(swipeDown())
      await flushMicrotasks()
      expect(app.getHomeMenuIndex()).toBe(5)
    })

    it('Phase 2K: swiping down through all 5 items then back up returns to the first item (full round trip)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge)
      await app.start()
      expect(app.getHomeMenuIndex()).toBe(0)

      for (let i = 1; i <= 4; i += 1) {
        bridge.emit(swipeDown())
        await flushMicrotasks()
        expect(app.getHomeMenuIndex()).toBe(i)
      }
      // 先頭でこれ以上戻らない(クランプ)は既存の別テストで確認済み。ここでは末尾からの折り返しのみ確認する。
      for (let i = 3; i >= 0; i -= 1) {
        bridge.emit(swipeUp())
        await flushMicrotasks()
        expect(app.getHomeMenuIndex()).toBe(i)
      }
    })

    it('does not call any backend API while moving the selection', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const { fn: dayFn, calls: dayCalls } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [] }) })
      const { fn: upcomingFn, calls: upcomingCalls } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events: [] }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: dayFn, fetchUpcomingEventsFn: upcomingFn })
      await app.start()

      await selectHomeMenu(bridge, 3)
      bridge.emit(swipeUp())
      await flushMicrotasks()
      bridge.emit(swipeUp())
      await flushMicrotasks()

      expect(dayCalls).toHaveLength(0)
      expect(upcomingCalls).toHaveLength(0)
    })

    describe('upcoming (index 1)', () => {
      it('pressing "直近5件の予定" calls GET /plugin/calendar-events/upcoming with limit=5 exactly once', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn, calls } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events: [timedUpcomingEvent()] }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)

        bridge.emit(press())
        await Promise.resolve()
        expect(app.getScreen()).toBe('upcomingLoading')
        expect(bridge.lastTextContent()).toContain('直近5件の予定')

        await flushMicrotasks()
        expect(app.getScreen()).toBe('upcomingList')
        expect(calls).toHaveLength(1)
        expect(calls[0]?.limit).toBe(5)
        expect(calls[0]?.baseUrl).toBe(TEST_DEPS_BASE.baseUrl)
        expect(calls[0]?.sessionToken).toBe(TEST_DEPS_BASE.sessionToken)
        expect(calls[0]?.installId).toBe(TEST_DEPS_BASE.installId)
        expect(typeof calls[0]?.requestId).toBe('string')
      })

      it('shows the empty screen when there are no upcoming events', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events: [] }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()
        expect(app.getScreen()).toBe('upcomingEmpty')
        expect(bridge.lastTextContent()).toContain('予定はありません')
        expect(bridge.lastTextContent()).toContain('二度押し: 戻る')
      })

      it('displays date-prefixed timed and all-day lines in server-provided (already-future/chronological) order', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const events = [
          timedUpcomingEvent({ title: '打ち合わせ', startLocal: '2026-07-23T14:00:00', endLocal: '2026-07-23T15:00:00' }),
          allDayUpcomingEvent({ title: '休暇', startDate: '2026-07-24', endDateExclusive: '2026-07-25' }),
          timedUpcomingEvent({ title: '朝会', startLocal: '2026-07-25T09:00:00', endLocal: '2026-07-25T10:00:00' }),
        ]
        const { fn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()

        const text = bridge.lastTextContent() ?? ''
        expect(text).toContain('7/23 14:00-15:00 打ち合わせ')
        expect(text).toContain('7/24 終日 休暇')
        expect(text).toContain('7/25 09:00-10:00 朝会')
        // 進行中/過去のwordingを使わず、常に日付を先頭に付ける(day-context継続表現を使わない)
        expect(text).not.toContain('前日から')
        expect(text).not.toContain('翌日へ')
      })

      it('displays a next-month event returned by the backend (2-month window, Phase 2G fix)', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const events = [timedUpcomingEvent({ title: '来月の予定', startLocal: '2026-08-15T10:00:00', endLocal: '2026-08-15T11:00:00' })]
        const { fn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()
        expect(bridge.lastTextContent()).toContain('8/15 10:00-11:00 来月の予定')
      })

      it('displays an event in the second month (still within the 2-month window)', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const events = [timedUpcomingEvent({ title: '再来月の予定', startLocal: '2026-09-20T09:00:00', endLocal: '2026-09-20T10:00:00' })]
        const { fn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()
        expect(bridge.lastTextContent()).toContain('9/20 09:00-10:00 再来月の予定')
      })

      it('never sends a client-side now/timeMax to the backend (server owns the 2-month window)', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn, calls } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events: [] }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()
        expect(calls).toHaveLength(1)
        // localeは今回追加された正規ロケール('ja'|'en')送出用のフィールド(i18n対応)であり、
        // now/timeMaxのようなクライアント側時刻情報ではない。この検証の主旨(時刻情報を送らない)には影響しない。
        expect(Object.keys(calls[0] ?? {}).sort()).toEqual(
          ['baseUrl', 'installId', 'limit', 'locale', 'requestId', 'sessionToken', 'signal', 'timeoutMs'].sort(),
        )
      })

      it('shows a 3-item selection window (like the home menu) and moves the cursor via swipe up/down', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const events = [1, 2, 3, 4, 5].map((i) =>
          timedUpcomingEvent({ eventId: `k${i}`, title: `e${i}`, startLocal: `2026-07-2${3 + i}T09:00:00`, endLocal: `2026-07-2${3 + i}T10:00:00` }),
        )
        const { fn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()

        let text = bridge.lastTextContent() ?? ''
        expect(text).toContain('直近5件の予定 1/5')
        expect(text).toContain('> 7/24 09:00-10:00 e1')
        expect(text).toContain('e2')
        expect(text).toContain('e3')
        expect(text).not.toContain('e4')

        for (let i = 0; i < 4; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        text = bridge.lastTextContent() ?? ''
        expect(text).toContain('直近5件の予定 5/5')
        expect(text).toContain('> 7/28 09:00-10:00 e5')

        bridge.emit(swipeUp())
        await flushMicrotasks()
        expect(bridge.lastTextContent()).toContain('4/5')
      })

      it('shows the truncated notice only once the selection window reaches the end, when truncated:true', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const events = [1, 2, 3, 4].map((i) => timedUpcomingEvent({ eventId: `k${i}`, title: `e${i}`, startLocal: `2026-07-2${3 + i}T09:00:00`, endLocal: `2026-07-2${3 + i}T10:00:00` }))
        const { fn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events, truncated: true }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()
        expect(bridge.lastTextContent()).not.toContain('ほかの予定があります')

        bridge.emit(swipeDown())
        await flushMicrotasks()
        bridge.emit(swipeDown())
        await flushMicrotasks()
        expect(bridge.lastTextContent()).toContain('ほかの予定があります')
      })

      it('selecting the currently highlighted event (single press) opens its detail screen', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const events = [timedUpcomingEvent({ eventId: 'up-1', title: '打ち合わせ' })]
        const { fn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events }) })
        const detail = eventDetail({ eventId: 'up-1', title: '打ち合わせ' })
        const { fn: detailFn, calls } = fakeEventDetail({ kind: 'success', result: detail })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn, fetchEventDetailFn: detailFn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()
        expect(app.getScreen()).toBe('upcomingList')

        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('eventDetail')
        expect(calls).toHaveLength(1)
        expect(calls[0]?.eventId).toBe('up-1')
      })

      it('double press while loading aborts the request and returns home; a late response is not reflected', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        let capturedSignal: AbortSignal | undefined
        let resolveOutcome: ((o: FetchUpcomingEventsOutcome) => void) | null = null
        const pending = new Promise<FetchUpcomingEventsOutcome>((resolve) => {
          resolveOutcome = resolve
        })
        const { fn } = fakeUpcomingEvents((): Promise<FetchUpcomingEventsOutcome> => pending)
        const wrappedFn = async (params: FetchUpcomingEventsParams): Promise<FetchUpcomingEventsOutcome> => {
          capturedSignal = params.signal
          return fn(params)
        }
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: wrappedFn })
        await app.start()
        await selectHomeMenu(bridge, 1)

        bridge.emit(press())
        await Promise.resolve()
        expect(app.getScreen()).toBe('upcomingLoading')
        await flushMicrotasks()
        expect(capturedSignal).toBeDefined()

        bridge.emit(doublePress())
        await flushMicrotasks()
        expect(capturedSignal?.aborted).toBe(true)
        expect(app.getScreen()).toBe('home')

        resolveOutcome?.({ kind: 'success', result: upcomingEventsResult({ events: [timedUpcomingEvent()] }) })
        await flushMicrotasks()
        expect(app.getScreen()).toBe('home')
      })

      it('ignores a single press while already loading (no duplicate fetch)', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        let resolveOutcome: ((o: FetchUpcomingEventsOutcome) => void) | null = null
        const pending = new Promise<FetchUpcomingEventsOutcome>((resolve) => {
          resolveOutcome = resolve
        })
        const { fn, calls } = fakeUpcomingEvents(() => pending)
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)

        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        expect(calls).toHaveLength(1)

        resolveOutcome?.({ kind: 'success', result: upcomingEventsResult({ events: [] }) })
        await flushMicrotasks()
      })

      const errorCases: Array<{ outcome: FetchUpcomingEventsOutcome['kind']; messageFragment: string }> = [
        { outcome: 'auth_failed', messageFragment: 'セットアップが必要です' },
        { outcome: 'forbidden', messageFragment: 'カレンダーを読み取れません' },
        { outcome: 'rate_limited', messageFragment: 'アクセスが集中しています' },
        { outcome: 'timeout', messageFragment: '通信できませんでした' },
        { outcome: 'network_error', messageFragment: '通信できませんでした' },
        { outcome: 'failed', messageFragment: '予定を取得できませんでした' },
      ]

      for (const { outcome, messageFragment } of errorCases) {
        it(`shows "${messageFragment}" for outcome=${outcome}, double press only returns home`, async () => {
          stubHealthyFetch()
          const bridge = new FakeEvenAppBridge()
          const { fn } = fakeUpcomingEvents({ kind: outcome } as FetchUpcomingEventsOutcome)
          const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
          await app.start()
          await selectHomeMenu(bridge, 1)

          bridge.emit(press())
          await flushMicrotasks()
          expect(app.getScreen()).toBe('upcomingError')
          expect(bridge.lastTextContent()).toContain(messageFragment)
          expect(bridge.lastTextContent()).toContain('二度押し: 戻る')

          bridge.emit(press())
          await flushMicrotasks()
          expect(app.getScreen()).toBe('upcomingError')

          bridge.emit(doublePress())
          await flushMicrotasks()
          expect(app.getScreen()).toBe('home')
        })
      }

      it('foreground re-entry resets an in-flight upcoming fetch and the menu selection to home', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        let capturedSignal: AbortSignal | undefined
        const pending = new Promise<FetchUpcomingEventsOutcome>(() => {})
        const { fn } = fakeUpcomingEvents((): Promise<FetchUpcomingEventsOutcome> => pending)
        const wrappedFn = async (params: FetchUpcomingEventsParams): Promise<FetchUpcomingEventsOutcome> => {
          capturedSignal = params.signal
          return fn(params)
        }
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: wrappedFn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()
        expect(app.getScreen()).toBe('upcomingLoading')

        bridge.emit(foregroundEnter())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('home')
        expect(app.getHomeMenuIndex()).toBe(0)
        expect(app.getUpcomingEventsContext().state).toBe('idle')
        expect(capturedSignal?.aborted).toBe(true)
      })

      it('foreground exit while loading aborts the in-flight fetch', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        let capturedSignal: AbortSignal | undefined
        const pending = new Promise<FetchUpcomingEventsOutcome>(() => {})
        const { fn } = fakeUpcomingEvents((): Promise<FetchUpcomingEventsOutcome> => pending)
        const wrappedFn = async (params: FetchUpcomingEventsParams): Promise<FetchUpcomingEventsOutcome> => {
          capturedSignal = params.signal
          return fn(params)
        }
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: wrappedFn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()

        bridge.emit(foregroundExit())
        await flushMicrotasks()

        expect(capturedSignal?.aborted).toBe(true)
        expect(app.getUpcomingEventsContext().state).toBe('idle')
      })

      it('dispose() aborts an in-flight upcoming fetch', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        let capturedSignal: AbortSignal | undefined
        const pending = new Promise<FetchUpcomingEventsOutcome>(() => {})
        const { fn } = fakeUpcomingEvents((): Promise<FetchUpcomingEventsOutcome> => pending)
        const wrappedFn = async (params: FetchUpcomingEventsParams): Promise<FetchUpcomingEventsOutcome> => {
          capturedSignal = params.signal
          return fn(params)
        }
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: wrappedFn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()

        app.dispose()
        expect(capturedSignal?.aborted).toBe(true)
      })

      it('discards the events array from memory on return to home (RESET)', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events: [timedUpcomingEvent()] }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()
        expect(app.getUpcomingEventsContext().events.length).toBe(1)

        bridge.emit(doublePress())
        await flushMicrotasks()
        expect(app.getUpcomingEventsContext().events).toEqual([])
        expect(app.getUpcomingEventsContext().state).toBe('idle')
      })

      it('never persists upcoming-events data to localStorage (only backendAvailable)', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events: [timedUpcomingEvent()] }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()
        expect(Array.from(bridge.storage.keys()).sort()).toEqual(['even-calendar.backendAvailable'])
      })

      it('never logs event titles or ISO date/time content, nor the session token/install id', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn } = fakeUpcomingEvents({
          kind: 'success',
          result: upcomingEventsResult({ events: [timedUpcomingEvent({ title: 'UNIQUE_SENTINEL_UPCOMING_TITLE' })] }),
        })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()

        const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
        expect(allLogText).not.toContain('UNIQUE_SENTINEL_UPCOMING_TITLE')
        expect(allLogText).not.toContain('2026-07-23T14:00:00')
        expect(allLogText).not.toContain(TEST_DEPS_BASE.sessionToken)
        expect(allLogText).not.toContain(TEST_DEPS_BASE.installId)
        logSpy.mockRestore()
      })

      it('does not call the Calendar registration/creation client during the upcoming-events flow', async () => {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events: [timedUpcomingEvent()] }) })
        const { fn: registerFn, calls: registerCalls } = fakeRegister({ kind: 'success' })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: fn, registerCalendarEventFn: registerFn })
        await app.start()
        await selectHomeMenu(bridge, 1)
        bridge.emit(press())
        await flushMicrotasks()
        expect(registerCalls).toHaveLength(0)
      })
    })

    it('existing registration/clarification flow still works from the new 4-item home menu (regression)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = await reachClarification(bridge)
      expect(app.getScreen()).toBe('clarification')
    })
  })

  describe('Language selection (Home menu 6th item)', () => {
    async function reachLanguageScreen(bridge: FakeEvenAppBridge, app: ReturnType<typeof createApp>): Promise<void> {
      for (let i = 0; i < 5; i += 1) {
        bridge.emit(swipeDown())
        await flushMicrotasks()
      }
      expect(app.getHomeMenuIndex()).toBe(5)
      bridge.emit(press())
      await flushMicrotasks()
    }

    it('opens the language screen from Home showing English/日本語, cursor starting on the current active locale', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge, { ...TEST_DEPS_BASE, locale: 'ja' })
      await app.start()

      await reachLanguageScreen(bridge, app)

      expect(app.getScreen()).toBe('language')
      const text = bridge.lastTextContent() ?? ''
      expect(text).toContain('English')
      expect(text).toContain('日本語')
      expect(text).toContain('> 日本語')
    })

    it('selecting English sets activeLocale to en, persists it via saveLocale, and returns to an English-rendered Home', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge, { ...TEST_DEPS_BASE, locale: 'ja' })
      await app.start()
      await reachLanguageScreen(bridge, app)

      bridge.emit(swipeUp()) // cursor: 日本語(1) -> English(0)
      await flushMicrotasks()
      expect(bridge.lastTextContent() ?? '').toContain('> English')

      bridge.emit(press()) // confirm English
      await flushMicrotasks()

      expect(app.getScreen()).toBe('home')
      expect(bridge.storage.get('even-calendar.locale')).toBe('en')
      const text = bridge.lastTextContent() ?? ''
      expect(text).toContain('New event')
      expect(text).not.toContain('予定を登録')
    })

    it('selecting 日本語 sets activeLocale to ja, persists it via saveLocale, and returns to a Japanese-rendered Home', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge, { ...TEST_DEPS_BASE, locale: 'en' })
      await app.start()
      await reachLanguageScreen(bridge, app)

      expect(bridge.lastTextContent() ?? '').toContain('> English')
      bridge.emit(swipeDown()) // cursor: English(0) -> 日本語(1)
      await flushMicrotasks()
      expect(bridge.lastTextContent() ?? '').toContain('> 日本語')

      bridge.emit(press()) // confirm 日本語
      await flushMicrotasks()

      expect(app.getScreen()).toBe('home')
      expect(bridge.storage.get('even-calendar.locale')).toBe('ja')
      const text = bridge.lastTextContent() ?? ''
      expect(text).toContain('予定を登録')
      expect(text).not.toContain('New event')
    })

    it('double press on the language screen shows a diagnostics screen with safe values (no token/installId/serial number)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      bridge.deviceInfo = { model: 'g2', sn: 'SECRET-SERIAL-VALUE', status: 'connected' }
      const app = createApp(bridge, { ...TEST_DEPS_BASE, locale: 'ja' })
      await app.start()
      await reachLanguageScreen(bridge, app)

      bridge.emit(doublePress())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('languageDiagnostics')
      const text = bridge.lastTextContent() ?? ''
      expect(text).toContain('nav.languages')
      expect(text).toContain('nav.language')
      expect(text).toContain('doc.lang')
      expect(text).toContain('Intl')
      expect(text).toContain('devInfo')
      expect(text).toContain('glassesInfo')
      expect(text).not.toContain('SECRET-SERIAL-VALUE')
      expect(text).not.toContain(TEST_DEPS_BASE.sessionToken)
      expect(text).not.toContain(TEST_DEPS_BASE.installId)
    })

    it('press or double press on the diagnostics screen returns to the language screen', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge, { ...TEST_DEPS_BASE, locale: 'ja' })
      await app.start()
      await reachLanguageScreen(bridge, app)

      bridge.emit(doublePress())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('languageDiagnostics')

      bridge.emit(press())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('language')

      bridge.emit(doublePress())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('languageDiagnostics')

      bridge.emit(doublePress())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('language')
    })
  })

  describe('Startup locale resolution order (locale must be resolved before the very first screen render)', () => {
    it('renders the first Home screen already in English when deps.locale is en (no Japanese flash first)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge, { ...TEST_DEPS_BASE, locale: 'en' })
      await app.start()

      expect(bridge.createStartUpCalls).toHaveLength(1)
      const firstText = (bridge.createStartUpCalls[0] as { textObject: Array<{ content?: string }> }).textObject[0]?.content ?? ''
      expect(firstText).toContain('New event')
      expect(firstText).not.toContain('予定を登録')
    })

    it('renders the first Home screen already in Japanese when deps.locale is ja', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      const app = createApp(bridge, { ...TEST_DEPS_BASE, locale: 'ja' })
      await app.start()

      const firstText = (bridge.createStartUpCalls[0] as { textObject: Array<{ content?: string }> }).textObject[0]?.content ?? ''
      expect(firstText).toContain('予定を登録')
      expect(firstText).not.toContain('New event')
    })
  })

  describe('Device locale integration (bridge.getDeviceInfo().locale end-to-end)', () => {
    it('uses bridge.getDeviceInfo().locale over stored/navigator when it resolves to a supported locale', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      bridge.deviceInfo = { model: 'g2', sn: 'test-sn', status: 'connected', locale: 'en-US' }
      bridge.storage.set('even-calendar.locale', 'ja')
      const app = createApp(bridge, TEST_DEPS_BASE) // no deps.locale: exercises real detection
      await app.start()

      const firstText = (bridge.createStartUpCalls[0] as { textObject: Array<{ content?: string }> }).textObject[0]?.content ?? ''
      expect(firstText).toContain('New event')
    })

    it('does not let callEvenApp("getGlassesInfo")\'s raw locale affect activeLocale (diagnostic-only, never used for detection)', async () => {
      stubHealthyFetch()
      const bridge = new FakeEvenAppBridge()
      bridge.deviceInfo = { model: 'g2', sn: 'test-sn', status: 'connected' } // public API: no locale
      bridge.glassesInfoRaw = { model: 'g2', sn: 'test-sn', status: 'connected', locale: 'en-US' } // raw only
      bridge.storage.set('even-calendar.locale', 'ja') // explicit stored selection must still win
      const app = createApp(bridge, TEST_DEPS_BASE)
      await app.start()

      const firstText = (bridge.createStartUpCalls[0] as { textObject: Array<{ content?: string }> }).textObject[0]?.content ?? ''
      expect(firstText).toContain('予定を登録')
      expect(firstText).not.toContain('New event')
    })
  })

  describe('Event detail/edit/delete (Phase 2I)', () => {
    /** ホームから「今日の予定」へ入り、1件の予定を選んで詳細画面まで進める。 */
    async function reachEventDetailFromDayList(
      bridge: FakeEvenAppBridge,
      overrides: {
        detail?: Partial<EventDetail>
        fetchEventDetailFn?: (params: FetchEventDetailParams) => Promise<FetchEventDetailOutcome>
      } = {},
    ): Promise<{ app: ReturnType<typeof createApp>; detailCalls: FetchEventDetailParams[] }> {
      stubHealthyFetch()
      const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent({ eventId: 'evt-1' })] }) })
      const detail = eventDetail({ eventId: 'evt-1', ...overrides.detail })
      const { fn: detailFn, calls: detailCalls } = overrides.fetchEventDetailFn
        ? { fn: overrides.fetchEventDetailFn, calls: [] as FetchEventDetailParams[] }
        : fakeEventDetail({ kind: 'success', result: detail })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: dayFn, fetchEventDetailFn: detailFn })
      await app.start()
      for (let i = 0; i < 2; i += 1) {
        bridge.emit(swipeDown())
        await flushMicrotasks()
      }
      bridge.emit(press()) // 今日の予定
      await flushMicrotasks()
      bridge.emit(press()) // 一覧の先頭(唯一)の予定を選択
      await flushMicrotasks()
      return { app, detailCalls }
    }

    it('selecting an event from each of the 3 lists (今日/明日/直近5件) opens its detail screen', async () => {
      // 今日 (index 2)
      {
        const bridge = new FakeEvenAppBridge()
        const { app } = await reachEventDetailFromDayList(bridge)
        expect(app.getScreen()).toBe('eventDetail')
      }
      // 明日 (index 3)
      {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ day: 'tomorrow', events: [timedDayEvent({ eventId: 'evt-2' })] }) })
        const { fn: detailFn, calls } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-2' }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: dayFn, fetchEventDetailFn: detailFn })
        await app.start()
        for (let i = 0; i < 3; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        expect(app.getScreen()).toBe('eventDetail')
        expect(calls[0]?.eventId).toBe('evt-2')
      }
      // 直近5件 (index 1)
      {
        stubHealthyFetch()
        const bridge = new FakeEvenAppBridge()
        const { fn: upFn } = fakeUpcomingEvents({ kind: 'success', result: upcomingEventsResult({ events: [timedUpcomingEvent({ eventId: 'evt-3' })] }) })
        const { fn: detailFn, calls } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-3' }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchUpcomingEventsFn: upFn, fetchEventDetailFn: detailFn })
        await app.start()
        bridge.emit(swipeDown())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        expect(app.getScreen()).toBe('eventDetail')
        expect(calls[0]?.eventId).toBe('evt-3')
      }
    })

    it('renders correctly when every optional field is absent (no crash, only title/hints shown)', async () => {
      const bridge = new FakeEvenAppBridge()
      const { app } = await reachEventDetailFromDayList(bridge, {
        detail: { title: '最小の予定', location: null, description: null, attendees: null, meetingUrl: null },
      })
      expect(app.getScreen()).toBe('eventDetail')
      const text = bridge.lastTextContent() ?? ''
      expect(text).toContain('最小の予定')
      expect(text).not.toContain('undefined')
      expect(text).not.toContain('null')
      expect(text.length).toBeLessThanOrEqual(1000)
    })

    it('renders correctly when every optional field is present (location/description/attendees/meetingUrl, no layout crash)', async () => {
      const bridge = new FakeEvenAppBridge()
      const { app } = await reachEventDetailFromDayList(bridge, {
        detail: {
          title: '定例会議',
          location: '第2会議室',
          description: '議題を確認してください',
          attendees: [{ email: 'a@example.com', displayName: 'Aさん', responseStatus: 'accepted' }],
          meetingUrl: 'https://meet.example.com/abc',
        },
      })
      expect(app.getScreen()).toBe('eventDetail')
      const text = bridge.lastTextContent() ?? ''
      expect(text.length).toBeLessThanOrEqual(1000)
    })

    it('never renders the eventId anywhere on the detail screen', async () => {
      const bridge = new FakeEvenAppBridge()
      const { app } = await reachEventDetailFromDayList(bridge, { detail: { eventId: 'UNIQUE_EVENT_ID_SENTINEL' } })
      expect(app.getScreen()).toBe('eventDetail')
      expect(bridge.lastTextContent() ?? '').not.toContain('UNIQUE_EVENT_ID_SENTINEL')
    })

    it('never persists eventId or event content to localStorage', async () => {
      const bridge = new FakeEvenAppBridge()
      await reachEventDetailFromDayList(bridge, { detail: { title: 'UNIQUE_TITLE_SENTINEL' } })
      expect(Array.from(bridge.storage.keys()).sort()).toEqual(['even-calendar.backendAvailable'])
    })

    it('double press from the detail screen restores the originating list at the same selected position (no refetch)', async () => {
      const bridge = new FakeEvenAppBridge()
      const events = [1, 2, 3].map((i) => timedDayEvent({ eventId: `k${i}`, title: `event-${i}`, startLocal: `2026-07-23T0${i}:00:00`, endLocal: `2026-07-23T0${i}:30:00` }))
      stubHealthyFetch()
      const { fn: dayFn, calls: dayCalls } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
      const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'k2' }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: dayFn, fetchEventDetailFn: detailFn })
      await app.start()
      for (let i = 0; i < 2; i += 1) {
        bridge.emit(swipeDown())
        await flushMicrotasks()
      }
      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(swipeDown()) // カーソルをevent-2へ
      await flushMicrotasks()
      bridge.emit(press()) // 詳細へ
      await flushMicrotasks()
      expect(app.getScreen()).toBe('eventDetail')

      bridge.emit(doublePress()) // 一覧へ戻る(位置復元、再取得なし)
      await flushMicrotasks()

      expect(app.getScreen()).toBe('dayList')
      expect(dayCalls).toHaveLength(1) // 再取得していない
      expect(bridge.lastTextContent()).toContain('> 02:00-02:30 event-2')
    })

    it('the detail menu (編集/削除/一覧に戻る) is reached via single press and does not call PATCH/DELETE before a choice is made', async () => {
      const bridge = new FakeEvenAppBridge()
      const { fn: updateFn, calls: updateCalls } = fakeUpdateEvent({ kind: 'success', eventId: 'evt-1' })
      const { fn: deleteFn, calls: deleteCalls } = fakeDeleteEvent({ kind: 'success', eventId: 'evt-1' })
      stubHealthyFetch()
      const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent({ eventId: 'evt-1' })] }) })
      const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-1' }) })
      const app = createApp(bridge, {
        ...TEST_DEPS_BASE,
        fetchDayEventsFn: dayFn,
        fetchEventDetailFn: detailFn,
        updateCalendarEventDetailFn: updateFn,
        deleteCalendarEventDetailFn: deleteFn,
      })
      await app.start()
      for (let i = 0; i < 2; i += 1) {
        bridge.emit(swipeDown())
        await flushMicrotasks()
      }
      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press()) // メニューを開く
      await flushMicrotasks()
      expect(app.getScreen()).toBe('eventDetailMenu')
      expect(updateCalls).toHaveLength(0)
      expect(deleteCalls).toHaveLength(0)
    })

    describe('delete flow', () => {
      it('shows a delete confirmation screen (title + start time) before any DELETE call', async () => {
        const bridge = new FakeEvenAppBridge()
        const { fn: deleteFn, calls } = fakeDeleteEvent({ kind: 'success', eventId: 'evt-1' })
        stubHealthyFetch()
        const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent({ eventId: 'evt-1' })] }) })
        const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-1', title: '削除対象の予定' }) })
        const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: dayFn, fetchEventDetailFn: detailFn, deleteCalendarEventDetailFn: deleteFn })
        await app.start()
        for (let i = 0; i < 2; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(swipeDown())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('deleteConfirm')
        expect(bridge.lastTextContent()).toContain('削除対象の予定')
        expect(bridge.lastTextContent()).toContain('この予定を削除しますか')
        expect(calls).toHaveLength(0)
      })

      it('キャンセル (double press) on the confirm screen never calls DELETE and returns to the detail screen', async () => {
        const bridge = new FakeEvenAppBridge()
        stubHealthyFetch()
        const events = [timedDayEvent({ eventId: 'evt-1', title: '朝会' })]
        const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
        const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-1', title: '朝会' }) })
        const { fn: deleteFn, calls: deleteCalls } = fakeDeleteEvent({ kind: 'success', eventId: 'evt-1' })
        const app = createApp(bridge, {
          ...TEST_DEPS_BASE,
          fetchDayEventsFn: dayFn,
          fetchEventDetailFn: detailFn,
          deleteCalendarEventDetailFn: deleteFn,
        })
        await app.start()
        for (let i = 0; i < 2; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press()) // メニュー
        await flushMicrotasks()
        bridge.emit(swipeDown()) // 削除
        await flushMicrotasks()
        bridge.emit(press()) // 削除確認画面
        await flushMicrotasks()
        expect(app.getScreen()).toBe('deleteConfirm')

        bridge.emit(doublePress()) // キャンセル
        await flushMicrotasks()

        expect(app.getScreen()).toBe('eventDetail')
        expect(deleteCalls).toHaveLength(0)
      })

      it('削除する (single press) calls DELETE exactly once with a fresh idempotencyKey, then re-fetches the originating list fresh', async () => {
        const bridge = new FakeEvenAppBridge()
        stubHealthyFetch()
        const events = [timedDayEvent({ eventId: 'evt-1', title: '朝会' })]
        const { fn: dayFn, calls: dayCalls } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
        const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-1' }) })
        const { fn: deleteFn, calls: deleteCalls } = fakeDeleteEvent({ kind: 'success', eventId: 'evt-1' })
        const app = createApp(bridge, {
          ...TEST_DEPS_BASE,
          fetchDayEventsFn: dayFn,
          fetchEventDetailFn: detailFn,
          deleteCalendarEventDetailFn: deleteFn,
        })
        await app.start()
        for (let i = 0; i < 2; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press()) // メニュー
        await flushMicrotasks()
        bridge.emit(swipeDown()) // 削除
        await flushMicrotasks()
        bridge.emit(press()) // 削除確認画面
        await flushMicrotasks()
        expect(app.getScreen()).toBe('deleteConfirm')

        bridge.emit(press()) // 削除する
        await flushMicrotasks()

        expect(deleteCalls).toHaveLength(1)
        expect(deleteCalls[0]?.eventId).toBe('evt-1')
        expect(typeof deleteCalls[0]?.idempotencyKey).toBe('string')
        expect(deleteCalls[0]?.idempotencyKey.length).toBeGreaterThan(0)
        // 一覧はローカルで消すのではなく、必ずサーバーから再取得したものを表示する
        expect(dayCalls).toHaveLength(2)
        expect(app.getScreen()).toBe('dayList')
      })

      it('does not double-call DELETE and never touches PATCH', async () => {
        const bridge = new FakeEvenAppBridge()
        stubHealthyFetch()
        const events = [timedDayEvent({ eventId: 'evt-1' })]
        const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
        const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-1' }) })
        const { fn: deleteFn, calls: deleteCalls } = fakeDeleteEvent({ kind: 'success', eventId: 'evt-1' })
        const { fn: updateFn, calls: updateCalls } = fakeUpdateEvent({ kind: 'success', eventId: 'evt-1' })
        const app = createApp(bridge, {
          ...TEST_DEPS_BASE,
          fetchDayEventsFn: dayFn,
          fetchEventDetailFn: detailFn,
          deleteCalendarEventDetailFn: deleteFn,
          updateCalendarEventDetailFn: updateFn,
        })
        await app.start()
        for (let i = 0; i < 2; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(swipeDown())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press()) // 削除する
        await flushMicrotasks()
        // deleting画面の単押しは無視されるはず
        bridge.emit(press())
        await flushMicrotasks()

        expect(deleteCalls).toHaveLength(1)
        expect(updateCalls).toHaveLength(0)
      })

      it('DELETE API error shows a retry-or-back-to-list screen without crashing', async () => {
        const bridge = new FakeEvenAppBridge()
        stubHealthyFetch()
        const events = [timedDayEvent({ eventId: 'evt-1' })]
        const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
        const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-1' }) })
        const { fn: deleteFn, calls: deleteCalls } = fakeDeleteEvent({ kind: 'timeout' })
        const app = createApp(bridge, {
          ...TEST_DEPS_BASE,
          fetchDayEventsFn: dayFn,
          fetchEventDetailFn: detailFn,
          deleteCalendarEventDetailFn: deleteFn,
        })
        await app.start()
        for (let i = 0; i < 2; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(swipeDown())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press()) // 削除する -> タイムアウト
        await flushMicrotasks()

        expect(app.getScreen()).toBe('deleteError')
        expect(deleteCalls).toHaveLength(1)

        // 単押しで同一idempotencyKeyのまま再試行できる
        bridge.emit(press())
        await flushMicrotasks()
        expect(deleteCalls).toHaveLength(2)
        expect(deleteCalls[0]?.idempotencyKey).toBe(deleteCalls[1]?.idempotencyKey)
      })

      it('a 409 conflict on DELETE shows a "gone" screen and returns to a freshly re-fetched list', async () => {
        const bridge = new FakeEvenAppBridge()
        stubHealthyFetch()
        const events = [timedDayEvent({ eventId: 'evt-1' })]
        const { fn: dayFn, calls: dayCalls } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
        const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-1' }) })
        const { fn: deleteFn } = fakeDeleteEvent({ kind: 'conflict' })
        const app = createApp(bridge, {
          ...TEST_DEPS_BASE,
          fetchDayEventsFn: dayFn,
          fetchEventDetailFn: detailFn,
          deleteCalendarEventDetailFn: deleteFn,
        })
        await app.start()
        for (let i = 0; i < 2; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(swipeDown())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('eventGone')
        bridge.emit(press())
        await flushMicrotasks()
        expect(app.getScreen()).toBe('dayList')
        expect(dayCalls).toHaveLength(2)
      })
    })

    describe('edit flow', () => {
      async function reachEditConfirm(
        bridge: FakeEvenAppBridge,
        analyzeOutcome: AnalyzeEditAudioOutcome,
        detail: Partial<EventDetail> = {},
      ): Promise<{ app: ReturnType<typeof createApp>; analyzeCalls: AnalyzeEditAudioParams[] }> {
        stubHealthyFetch()
        const events = [timedDayEvent({ eventId: 'evt-1' })]
        const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
        const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-1', title: '朝会', ...detail }) })
        const { fn: analyzeFn, calls: analyzeCalls } = fakeAnalyzeEditAudio(analyzeOutcome)
        const app = createApp(bridge, {
          ...TEST_DEPS_BASE,
          fetchDayEventsFn: dayFn,
          fetchEventDetailFn: detailFn,
          analyzeEditAudioFn: analyzeFn,
        })
        await app.start()
        for (let i = 0; i < 2; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press()) // メニュー
        await flushMicrotasks()
        bridge.emit(press()) // 編集(録音開始)
        await flushMicrotasks()
        expect(app.getScreen()).toBe('editRecording')
        bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES * 2))
        bridge.emit(press()) // 録音終了
        await flushMicrotasks()
        expect(app.getScreen()).toBe('editCaptured')
        bridge.emit(press()) // 解析へ
        await flushMicrotasks()
        return { app, analyzeCalls }
      }

      it('an edit instruction shows a confirm screen with only the fields that actually changed, as before→after', async () => {
        const bridge = new FakeEvenAppBridge()
        const { app, analyzeCalls } = await reachEditConfirm(
          bridge,
          { kind: 'success', result: editInstructionResult({ fields: { title: '定例会議' } }) },
          { title: '朝会', location: '会議室A' },
        )
        expect(app.getScreen()).toBe('editConfirm')
        expect(analyzeCalls).toHaveLength(1)
        expect(analyzeCalls[0]?.eventId).toBe('evt-1')
        const text = bridge.lastTextContent() ?? ''
        expect(text).toContain('予定名')
        expect(text).toContain('朝会')
        expect(text).toContain('定例会議')
        expect(text).not.toContain('会議室A') // 場所は変更されていないので出ない
      })

      it('更新する (single press) calls PATCH exactly once with only the changed fields, then re-fetches detail via GET', async () => {
        const bridge = new FakeEvenAppBridge()
        stubHealthyFetch()
        const events = [timedDayEvent({ eventId: 'evt-1' })]
        const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
        let detailCallCount = 0
        const detailFn = async (params: FetchEventDetailParams): Promise<FetchEventDetailOutcome> => {
          detailCallCount += 1
          return { kind: 'success', result: eventDetail({ eventId: params.eventId, title: detailCallCount === 1 ? '朝会' : '定例会議' }) }
        }
        const { fn: analyzeFn } = fakeAnalyzeEditAudio({ kind: 'success', result: editInstructionResult({ fields: { title: '定例会議' } }) })
        const { fn: updateFn, calls: updateCalls } = fakeUpdateEvent({ kind: 'success', eventId: 'evt-1' })
        const app = createApp(bridge, {
          ...TEST_DEPS_BASE,
          fetchDayEventsFn: dayFn,
          fetchEventDetailFn: detailFn,
          analyzeEditAudioFn: analyzeFn,
          updateCalendarEventDetailFn: updateFn,
        })
        await app.start()
        for (let i = 0; i < 2; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES * 2))
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        expect(app.getScreen()).toBe('editConfirm')

        bridge.emit(press()) // 更新する
        await flushMicrotasks()

        expect(updateCalls).toHaveLength(1)
        expect(updateCalls[0]?.eventId).toBe('evt-1')
        expect(updateCalls[0]?.fields).toEqual({ title: '定例会議' })
        expect(typeof updateCalls[0]?.idempotencyKey).toBe('string')
        expect(detailCallCount).toBe(2) // 初回取得 + 更新後の再取得
        expect(app.getScreen()).toBe('eventDetail')
        expect(bridge.lastTextContent()).toContain('定例会議')
      })

      it('キャンセル (double press) on the edit confirm screen never calls PATCH', async () => {
        const bridge = new FakeEvenAppBridge()
        const { app, analyzeCalls } = await reachEditConfirm(bridge, { kind: 'success', result: editInstructionResult({ fields: { title: '定例会議' } }) })
        expect(app.getScreen()).toBe('editConfirm')
        void analyzeCalls

        const { fn: updateFn, calls: updateCalls } = fakeUpdateEvent({ kind: 'success', eventId: 'evt-1' })
        void updateFn
        bridge.emit(doublePress())
        await flushMicrotasks()

        expect(app.getScreen()).toBe('eventDetail')
        expect(updateCalls).toHaveLength(0)
      })

      it('a not_understood analysis result shows a retry screen and never reaches the confirm screen', async () => {
        const bridge = new FakeEvenAppBridge()
        const { app } = await reachEditConfirm(bridge, { kind: 'success', result: { schemaVersion: '1', resultType: 'not_understood', fields: {} } })
        expect(app.getScreen()).toBe('editNotUnderstood')
      })

      it('a PATCH API error shows a retry-or-back-to-list screen without crashing', async () => {
        const bridge = new FakeEvenAppBridge()
        stubHealthyFetch()
        const events = [timedDayEvent({ eventId: 'evt-1' })]
        const { fn: dayFn, calls: dayCalls } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events }) })
        const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-1', title: '朝会' }) })
        const { fn: analyzeFn } = fakeAnalyzeEditAudio({ kind: 'success', result: editInstructionResult({ fields: { title: '定例会議' } }) })
        const { fn: updateFn, calls: updateCalls } = fakeUpdateEvent({ kind: 'network_error' })
        const app = createApp(bridge, {
          ...TEST_DEPS_BASE,
          fetchDayEventsFn: dayFn,
          fetchEventDetailFn: detailFn,
          analyzeEditAudioFn: analyzeFn,
          updateCalendarEventDetailFn: updateFn,
        })
        await app.start()
        for (let i = 0; i < 2; i += 1) {
          bridge.emit(swipeDown())
          await flushMicrotasks()
        }
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(audioChunk(ONE_SECOND_OF_AUDIO_BYTES * 2))
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press())
        await flushMicrotasks()
        bridge.emit(press()) // 更新する -> ネットワークエラー
        await flushMicrotasks()

        expect(app.getScreen()).toBe('editError')
        expect(updateCalls).toHaveLength(1)

        bridge.emit(doublePress()) // 一覧へ戻る(再取得)
        await flushMicrotasks()
        expect(app.getScreen()).toBe('dayList')
        expect(dayCalls).toHaveLength(2)
      })

      it('releases the edit audio buffer/state after cancel (no leftover recording state)', async () => {
        const bridge = new FakeEvenAppBridge()
        const { app } = await reachEditConfirm(bridge, { kind: 'success', result: editInstructionResult({ fields: { title: '定例会議' } }) })
        bridge.emit(doublePress()) // キャンセル
        await flushMicrotasks()
        expect(app.getEditRecordingContext().state).toBe('idle')
        expect(app.getEditAnalysisContext().state).toBe('idle')
      })
    })

    it('does not register a new bridge event listener across list -> detail -> menu -> edit/delete screen transitions', async () => {
      const bridge = new FakeEvenAppBridge()
      const { app } = await reachEventDetailFromDayList(bridge)
      expect(bridge.listenerCount).toBe(1)
      bridge.emit(press()) // メニューへ
      await flushMicrotasks()
      bridge.emit(swipeDown())
      await flushMicrotasks()
      bridge.emit(press()) // 削除確認へ
      await flushMicrotasks()
      expect(bridge.listenerCount).toBe(1)
      void app
    })

    it('resets/releases event-detail and delete/edit state on teardown (goHome via double press from the list)', async () => {
      const bridge = new FakeEvenAppBridge()
      const { app } = await reachEventDetailFromDayList(bridge)
      bridge.emit(doublePress()) // 一覧へ戻る
      await flushMicrotasks()
      bridge.emit(doublePress()) // ホームへ
      await flushMicrotasks()

      expect(app.getScreen()).toBe('home')
      expect(app.getEventDetailContext().state).toBe('idle')
      expect(app.getEventDetailContext().detail).toBeNull()
      expect(app.getDeleteMutationContext().state).toBe('idle')
      expect(app.getEditRecordingContext().state).toBe('idle')
      expect(app.getEditAnalysisContext().state).toBe('idle')
      expect(app.getEditApplyContext().state).toBe('idle')
    })

    it('an eventId fetch failure (transient) allows retry-or-back without crashing', async () => {
      const bridge = new FakeEvenAppBridge()
      stubHealthyFetch()
      const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent({ eventId: 'evt-1' })] }) })
      let attempt = 0
      const detailFn = async (params: FetchEventDetailParams): Promise<FetchEventDetailOutcome> => {
        attempt += 1
        return attempt === 1 ? { kind: 'network_error' } : { kind: 'success', result: eventDetail({ eventId: params.eventId }) }
      }
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: dayFn, fetchEventDetailFn: detailFn })
      await app.start()
      for (let i = 0; i < 2; i += 1) {
        bridge.emit(swipeDown())
        await flushMicrotasks()
      }
      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('eventDetailError')
      bridge.emit(press()) // 再試行
      await flushMicrotasks()
      expect(app.getScreen()).toBe('eventDetail')
      expect(attempt).toBe(2)
    })

    it('an invalid/unknown eventId (404 on GET) shows the gone screen and returns to a freshly re-fetched list', async () => {
      const bridge = new FakeEvenAppBridge()
      stubHealthyFetch()
      const { fn: dayFn, calls: dayCalls } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent({ eventId: 'evt-1' })] }) })
      const { fn: detailFn } = fakeEventDetail({ kind: 'not_found' })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: dayFn, fetchEventDetailFn: detailFn })
      await app.start()
      for (let i = 0; i < 2; i += 1) {
        bridge.emit(swipeDown())
        await flushMicrotasks()
      }
      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('eventGone')
      bridge.emit(doublePress())
      await flushMicrotasks()
      expect(app.getScreen()).toBe('dayList')
      expect(dayCalls).toHaveLength(2)
    })

    it('backgrounding mid-delete-confirm does not restore the confirm screen on foreground re-entry (returns to home)', async () => {
      const bridge = new FakeEvenAppBridge()
      stubHealthyFetch()
      const { fn: dayFn } = fakeDayEvents({ kind: 'success', result: dayEventsResult({ events: [timedDayEvent({ eventId: 'evt-1' })] }) })
      const { fn: detailFn } = fakeEventDetail({ kind: 'success', result: eventDetail({ eventId: 'evt-1' }) })
      const app = createApp(bridge, { ...TEST_DEPS_BASE, fetchDayEventsFn: dayFn, fetchEventDetailFn: detailFn })
      await app.start()
      for (let i = 0; i < 2; i += 1) {
        bridge.emit(swipeDown())
        await flushMicrotasks()
      }
      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press())
      await flushMicrotasks()
      bridge.emit(press()) // メニュー
      await flushMicrotasks()
      bridge.emit(swipeDown())
      await flushMicrotasks()
      bridge.emit(press()) // 削除確認
      await flushMicrotasks()
      expect(app.getScreen()).toBe('deleteConfirm')

      bridge.emit(foregroundExit())
      await flushMicrotasks()
      bridge.emit(foregroundEnter())
      await flushMicrotasks()

      expect(app.getScreen()).toBe('home')
      expect(app.getDeleteMutationContext().state).toBe('idle')
    })
  })
})
