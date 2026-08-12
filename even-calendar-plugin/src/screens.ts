import { formatAllDayWhen } from './allDayDisplay'
import { formatCandidateWhenEn } from './i18n/dateFormats'
import { getActiveLocale, type Locale } from './i18n/locale'

// 画面文言はロケール別テーブルに集約する。既存のexport関数のシグネチャは意図的に一切変更しない
// (app.ts側の98箇所の呼び出しを書き換えないため)。現在ロケールはi18n/locale.tsのモジュールスコープ値。
// 既定は'ja'のため、setActiveLocaleを呼ばない限り従来と完全に同一の文字列を返す。

/**
 * ホームメニューは「要素数6・順序不変・index4が再接続・index5が言語選択」が不変条件。
 * 両ロケールで型として固定する(Phase 2K: 5要素だったものに、末尾へLanguage項目を追加)。
 */
type HomeMenuTuple = readonly [string, string, string, string, string, string]

export const HOME_MENU_ITEMS_BY_LOCALE: Record<Locale, HomeMenuTuple> = {
  // Phase 2K: 5番目の項目はGoogle OAuth再連携専用。6番目は言語選択画面(Language)専用。
  // 既存5項目の順番・動作は変更しない(末尾に追加のみ)。
  ja: ['予定を登録', '直近5件の予定', '今日の予定', '明日の予定', 'Googleカレンダーを再接続', '言語'],
  en: ['New event', 'Next 5 events', "Today's events", "Tomorrow's events", 'Reconnect Google Calendar', 'Language'],
}

/** 後方互換のため日本語の配列をそのまま公開し続ける(既存テスト・既存importが参照している)。 */
export const HOME_MENU_ITEMS = HOME_MENU_ITEMS_BY_LOCALE.ja
export const HOME_MENU_ITEM_COUNT = HOME_MENU_ITEMS.length
const HOME_MENU_WINDOW_SIZE = 3

const EVENT_DETAIL_MENU_ITEMS_BY_LOCALE: Record<Locale, readonly [string, string, string]> = {
  ja: ['編集', '削除', '一覧に戻る'],
  en: ['Edit', 'Delete', 'Back to list'],
}

export const EVENT_DETAIL_MENU_ITEMS = EVENT_DETAIL_MENU_ITEMS_BY_LOCALE.ja

export type PairingErrorKind = 'expired' | 'communication_failure' | 'cancelled' | 'auth_failure'

interface ScreenStrings {
  homeTitle: string
  hintSwipeSelect: string
  hintPressRun: string
  hintDoubleExit: string

  recording: string
  pressAgainToFinish: string
  hintDoubleCancel: string
  hintDoubleAbort: string
  hintDoubleRetry: string
  hintDoubleBack: string
  hintDoubleToList: string
  hintPressHome: string
  hintPressOrDoubleHome: string
  hintPressOrDoubleToList: string

  audioCaptured: string
  duration: (seconds: number) => string
  hintPressConfirm: string
  tooShort: string

  analyzing: string
  pleaseWait: string

  confirmEvent: string
  hintPressToFinalConfirm: string
  registerQuestion: string
  hintPressRegister: string
  registering: string
  checkingResultLine1: string
  checkingResultLine2: string
  registered: string

  clarificationNeeded: string
  hintPressAnswer: string
  notCalendarLine1: string
  notCalendarLine2: string
  hintPressRetry: string

  followupReady: string
  hintPressStartRecording: string
  followupRecording: string
  followupCaptured: string
  hintPressSend: string

  dayLabel: Record<'today' | 'tomorrow', string>
  loading: string
  noEvents: string
  moreEvents: string
  hintPressDetail: string
  upcomingLabel: string

  menu: string
  hintSwipeMore: string
  hintPressMenu: string
  hintPressSelect: string
  hintPressRetryAction: string

  goneLine1: string
  goneLine2: string
  deleteQuestion: string
  hintPressDelete: string
  deleting: string

  editRecording: string
  editCaptured: string
  hintDoubleRerecord: string
  editAnalyzing: string
  editNotUnderstoodLine1: string
  editNotUnderstoodLine2: string
  hintPressRerecord: string
  hintDoubleBackToEvent: string
  editConfirmQuestion: string
  hintPressUpdate: string
  editApplying: string

  appName: string
  notConnectedLine1: string
  notConnectedLine2: string
  hintPressStartPairing: string
  openOnPhone: string
  waitingForConnection: string
  connected: string
  hintPressToMenu: string
  pairingError: Record<PairingErrorKind, string>
  hintPressOrDoubleReconnect: string

  languageTitle: string
  hintDoubleDiagnostics: string
  hintPressOrDoubleBack: string
  diagnosticsTitle: string
  diagLabelNavLanguages: string
  diagLabelNavLanguage: string
  diagLabelDocLang: string
  diagLabelIntlLocale: string
  diagLabelStored: string
  diagLabelActive: string
  diagLabelDeviceInfo: string
  diagLabelGlassesInfo: string
}

const JA: ScreenStrings = {
  homeTitle: 'Calendar with Gemini',
  hintSwipeSelect: '上下スワイプ: 選択',
  hintPressRun: '押す: 実行',
  hintDoubleExit: '二度押し: 終了',

  recording: '録音中...',
  pressAgainToFinish: 'もう一度押して終了',
  hintDoubleCancel: '二度押し: キャンセル',
  hintDoubleAbort: '二度押し: 中止',
  hintDoubleRetry: '二度押し: やり直し',
  hintDoubleBack: '二度押し: 戻る',
  hintDoubleToList: '二度押し: 一覧へ',
  hintPressHome: '押す: ホーム',
  hintPressOrDoubleHome: '押す/二度押し: ホーム',
  hintPressOrDoubleToList: '押す/二度押し: 一覧へ',

  audioCaptured: '音声を取得しました',
  duration: (seconds) => `長さ: 約${seconds}秒`,
  hintPressConfirm: '押す: 確認へ',
  tooShort: '短すぎます',

  analyzing: '解析中...',
  pleaseWait: 'しばらくお待ちください',

  confirmEvent: '予定を確認',
  hintPressToFinalConfirm: '押す: 登録確認',
  registerQuestion: '登録しますか?',
  hintPressRegister: '押す: 登録',
  registering: '登録中...',
  checkingResultLine1: '登録結果を',
  checkingResultLine2: '確認しています',
  registered: '登録しました',

  clarificationNeeded: '確認が必要です',
  hintPressAnswer: '押す: 回答する',
  notCalendarLine1: '予定の内容を',
  notCalendarLine2: '話してください',
  hintPressRetry: '押す: やり直す',

  followupReady: '回答を話してください',
  hintPressStartRecording: '押す: 録音開始',
  followupRecording: '回答を録音中...',
  followupCaptured: '回答を取得しました',
  hintPressSend: '押す: 送信',

  dayLabel: { today: '今日の予定', tomorrow: '明日の予定' },
  loading: '読み込み中...',
  noEvents: '予定はありません',
  moreEvents: 'ほかの予定があります',
  hintPressDetail: '押す: 詳細を見る',
  upcomingLabel: '直近5件の予定',

  menu: 'メニュー',
  hintSwipeMore: '上下スワイプ: 続き',
  hintPressMenu: '押す: メニュー',
  hintPressSelect: '押す: 選択',
  hintPressRetryAction: '押す: 再試行',

  goneLine1: 'この予定は更新または',
  goneLine2: '削除されました',
  deleteQuestion: 'この予定を削除しますか?',
  hintPressDelete: '押す: 削除する',
  deleting: '削除中...',

  editRecording: '変更内容を録音中...',
  editCaptured: '変更内容を取得しました',
  hintDoubleRerecord: '二度押し: 録音し直す',
  editAnalyzing: '変更内容を解析中...',
  editNotUnderstoodLine1: '変更内容を',
  editNotUnderstoodLine2: '認識できませんでした',
  hintPressRerecord: '押す: 録音し直す',
  hintDoubleBackToEvent: '二度押し: 予定に戻る',
  editConfirmQuestion: 'この内容で更新しますか?',
  hintPressUpdate: '押す: 更新する',
  editApplying: '更新中...',

  appName: 'Calendar with Gemini',
  notConnectedLine1: 'Googleカレンダーとの',
  notConnectedLine2: '接続が必要です',
  hintPressStartPairing: '押す: 接続を開始',
  openOnPhone: 'スマートフォンで開く',
  waitingForConnection: '接続待ち...',
  connected: '接続しました',
  hintPressToMenu: '押す: メニューへ',
  pairingError: {
    expired: '接続の有効期限が切れました',
    communication_failure: '通信に失敗しました',
    cancelled: '接続を中止しました',
    auth_failure: '認証に失敗しました',
  },
  hintPressOrDoubleReconnect: '押す/二度押し: 再接続',

  languageTitle: '言語',
  hintDoubleDiagnostics: '二度押し: 診断情報',
  hintPressOrDoubleBack: '押す/二度押し: 戻る',
  diagnosticsTitle: '診断情報',
  diagLabelNavLanguages: 'nav.languages',
  diagLabelNavLanguage: 'nav.language',
  diagLabelDocLang: 'doc.lang',
  diagLabelIntlLocale: 'Intl',
  diagLabelStored: '保存値',
  diagLabelActive: '現在',
  diagLabelDeviceInfo: 'devInfo',
  diagLabelGlassesInfo: 'glassesInfo',
}

// 英語版。G2は576x288の1コンテナ表示のため、行数と1行の短さを日本語版と揃える。
// 記号は半角のみ(全角チルダ・enダッシュはG2フォント欠字リスクのため使わない)。
const EN: ScreenStrings = {
  homeTitle: 'Calendar with Gemini',
  hintSwipeSelect: 'Swipe: select',
  hintPressRun: 'Press: open',
  hintDoubleExit: 'Double press: exit',

  recording: 'Recording...',
  pressAgainToFinish: 'Press again to finish',
  hintDoubleCancel: 'Double press: cancel',
  hintDoubleAbort: 'Double press: cancel',
  hintDoubleRetry: 'Double press: redo',
  hintDoubleBack: 'Double press: back',
  hintDoubleToList: 'Double press: list',
  hintPressHome: 'Press: home',
  hintPressOrDoubleHome: 'Press/double press: home',
  hintPressOrDoubleToList: 'Press/double press: list',

  audioCaptured: 'Audio captured',
  duration: (seconds) => `Length: about ${seconds}s`,
  hintPressConfirm: 'Press: review',
  tooShort: 'Too short',

  analyzing: 'Analyzing...',
  pleaseWait: 'Please wait',

  confirmEvent: 'Review event',
  hintPressToFinalConfirm: 'Press: confirm',
  registerQuestion: 'Add this event?',
  hintPressRegister: 'Press: add',
  registering: 'Adding...',
  checkingResultLine1: 'Checking the',
  checkingResultLine2: 'result',
  registered: 'Event added',

  clarificationNeeded: 'Need to confirm',
  hintPressAnswer: 'Press: answer',
  notCalendarLine1: 'Please describe',
  notCalendarLine2: 'the event',
  hintPressRetry: 'Press: try again',

  followupReady: 'Please say your answer',
  hintPressStartRecording: 'Press: start recording',
  followupRecording: 'Recording answer...',
  followupCaptured: 'Answer captured',
  hintPressSend: 'Press: send',

  dayLabel: { today: "Today's events", tomorrow: "Tomorrow's events" },
  loading: 'Loading...',
  noEvents: 'No events',
  moreEvents: 'More events',
  hintPressDetail: 'Press: details',
  upcomingLabel: 'Next 5 events',

  menu: 'Menu',
  hintSwipeMore: 'Swipe: more',
  hintPressMenu: 'Press: menu',
  hintPressSelect: 'Press: select',
  hintPressRetryAction: 'Press: retry',

  goneLine1: 'This event was updated',
  goneLine2: 'or deleted',
  deleteQuestion: 'Delete this event?',
  hintPressDelete: 'Press: delete',
  deleting: 'Deleting...',

  editRecording: 'Recording changes...',
  editCaptured: 'Changes captured',
  hintDoubleRerecord: 'Double press: record again',
  editAnalyzing: 'Analyzing changes...',
  editNotUnderstoodLine1: 'Could not understand',
  editNotUnderstoodLine2: 'the changes',
  hintPressRerecord: 'Press: record again',
  hintDoubleBackToEvent: 'Double press: back to event',
  editConfirmQuestion: 'Apply these changes?',
  hintPressUpdate: 'Press: update',
  editApplying: 'Updating...',

  appName: 'Calendar with Gemini',
  notConnectedLine1: 'Connect your',
  notConnectedLine2: 'Google Calendar',
  hintPressStartPairing: 'Press: connect',
  openOnPhone: 'Open on your phone',
  waitingForConnection: 'Waiting...',
  connected: 'Connected',
  hintPressToMenu: 'Press: menu',
  pairingError: {
    expired: 'The connection request expired',
    communication_failure: 'Communication failed',
    cancelled: 'Connection cancelled',
    auth_failure: 'Authentication failed',
  },
  hintPressOrDoubleReconnect: 'Press/double press: reconnect',

  languageTitle: 'Language',
  hintDoubleDiagnostics: 'Double press: diagnostics',
  hintPressOrDoubleBack: 'Press/double press: back',
  diagnosticsTitle: 'Diagnostics',
  diagLabelNavLanguages: 'nav.languages',
  diagLabelNavLanguage: 'nav.language',
  diagLabelDocLang: 'doc.lang',
  diagLabelIntlLocale: 'Intl',
  diagLabelStored: 'stored',
  diagLabelActive: 'active',
  diagLabelDeviceInfo: 'devInfo',
  diagLabelGlassesInfo: 'glassesInfo',
}

const STRINGS: Record<Locale, ScreenStrings> = { ja: JA, en: EN }

function s(): ScreenStrings {
  return STRINGS[getActiveLocale()] ?? JA
}

/**
 * ネイティブスクロールを使わないNSize項目ウィンドウ方式の共通計算。選択位置が末尾寄りのときは
 * ウィンドウを末尾方向へずらし、常に選択項目を表示範囲内に収める(scrollIntoView・scrollTopは使わない)。
 * ホームメニューの3項目ウィンドウ選択と、今日/明日/直近5件リストの選択カーソルの両方で使う。
 */
export function windowStart(selectedIndex: number, total: number, windowSize: number): number {
  return Math.max(0, Math.min(selectedIndex - 1, total - windowSize))
}

/**
 * ネイティブスクロールを使わない3項目ウィンドウ方式。内部にはHOME_MENU_ITEM_COUNT件保持するが、
 * G2の1画面には最大HOME_MENU_WINDOW_SIZE件だけを表示する。
 * ヘッダーに "選択位置/全件数" を表示する。
 */
export function homeScreenText(selectedIndex: number): string {
  const items = HOME_MENU_ITEMS_BY_LOCALE[getActiveLocale()] ?? HOME_MENU_ITEMS_BY_LOCALE.ja
  const total = items.length
  const start = windowStart(selectedIndex, total, HOME_MENU_WINDOW_SIZE)
  const visibleItems = items.slice(start, start + HOME_MENU_WINDOW_SIZE)
  const lines = visibleItems.map((item, i) => (start + i === selectedIndex ? `> ${item}` : `  ${item}`))
  const header = `${s().homeTitle} ${selectedIndex + 1}/${total}`
  return [header, '', ...lines, '', s().hintSwipeSelect, s().hintPressRun, s().hintDoubleExit].join('\n')
}

export function recordingScreenText(): string {
  return [s().recording, '', s().pressAgainToFinish, s().hintDoubleCancel].join('\n')
}

export function capturedScreenText(durationSec: number): string {
  const rounded = Math.max(1, Math.round(durationSec))
  return [s().audioCaptured, s().duration(rounded), '', s().hintPressConfirm, s().hintDoubleRetry].join('\n')
}

export function tooShortScreenText(): string {
  return [s().tooShort, '', s().hintPressOrDoubleHome].join('\n')
}

const MAX_DISPLAY_LENGTH = 60

/** 576x288の1コンテナに安全に収まるよう、長い文字列は省略記号付きで切り詰める。HTMLとしては解釈しない(単純なtext)。 */
export function truncateForDisplay(text: string, maxLength: number = MAX_DISPLAY_LENGTH): string {
  if (text.length <= maxLength) return text
  return text.slice(0, Math.max(0, maxLength - 1)) + '…'
}

export function analyzingScreenText(): string {
  return [s().analyzing, s().pleaseWait, '', s().hintDoubleAbort].join('\n')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** startLocal/endLocalは事前に app 側で妥当性検証済みであること前提のフォーマット関数。 */
export function formatCandidateWhen(
  start: { month: number; day: number; hour: number; minute: number },
  end: { hour: number; minute: number },
): string {
  if (getActiveLocale() === 'en') return formatCandidateWhenEn(start, end)
  return `${start.month}/${start.day} ${pad2(start.hour)}:${pad2(start.minute)}-${pad2(end.hour)}:${pad2(end.minute)}`
}

/**
 * 終日候補用のwhenTextを作る(候補確認/最終確認/登録完了の全画面で共通)。
 * 排他的終了日(endDateExclusive)から利用者向け包含最終日への変換はallDayDisplay.tsの
 * formatAllDayWhen()だけが行う(ここでは呼び出すだけで、独自の-1日計算は行わない)。
 */
export function formatAllDayCandidateWhen(startDate: string, endDateExclusive: string): string {
  return formatAllDayWhen(startDate, endDateExclusive)
}

export function candidateScreenText(title: string, whenText: string): string {
  return [s().confirmEvent, truncateForDisplay(title), whenText, '', s().hintPressToFinalConfirm, s().hintDoubleAbort].join('\n')
}

export function finalConfirmScreenText(title: string, whenText: string): string {
  return [s().registerQuestion, truncateForDisplay(title), whenText, '', s().hintPressRegister, s().hintDoubleAbort].join('\n')
}

export function registeringScreenText(): string {
  return [s().registering, s().pleaseWait].join('\n')
}

export function checkingStatusScreenText(): string {
  return [s().checkingResultLine1, s().checkingResultLine2, '', s().pleaseWait].join('\n')
}

export function registeredScreenText(whenText: string): string {
  return [s().registered, whenText, '', s().hintPressHome].join('\n')
}

export function clarificationScreenText(question: string): string {
  return [s().clarificationNeeded, truncateForDisplay(question), '', s().hintPressAnswer, s().hintDoubleAbort].join('\n')
}

export function notCalendarScreenText(): string {
  return [s().notCalendarLine1, s().notCalendarLine2, '', s().hintPressRetry, s().hintDoubleAbort].join('\n')
}

export function followupReadyScreenText(): string {
  return [s().followupReady, '', s().hintPressStartRecording, s().hintDoubleAbort].join('\n')
}

export function followupRecordingScreenText(): string {
  return [s().followupRecording, '', s().pressAgainToFinish, s().hintDoubleAbort].join('\n')
}

export function followupCapturedScreenText(durationSec: number): string {
  const rounded = Math.max(1, Math.round(durationSec))
  return [s().followupCaptured, s().duration(rounded), '', s().hintPressSend, s().hintDoubleRetry].join('\n')
}

function dayLabel(day: 'today' | 'tomorrow'): string {
  return s().dayLabel[day]
}

export function dayLoadingScreenText(day: 'today' | 'tomorrow'): string {
  return [dayLabel(day), s().loading].join('\n')
}

export function dayEmptyScreenText(day: 'today' | 'tomorrow'): string {
  return [dayLabel(day), s().noEvents, '', s().hintDoubleBack].join('\n')
}

/**
 * lines(選択カーソルウィンドウ、最大3行)は事前にformatDayEventLine + truncateForDisplayで整形し、
 * 選択中の1行だけ'> 'プレフィックスを付けた状態で渡されている前提(ホームメニューと同じ表現)。
 * isLastWindowは表示中のウィンドウが末尾(選択可能な最後の項目を含む)かどうか。
 */
export function dayEventsScreenText(
  day: 'today' | 'tomorrow',
  selectedIndex: number,
  totalCount: number,
  lines: string[],
  isLastWindow: boolean,
  truncated: boolean,
): string {
  const header = `${dayLabel(day)} ${selectedIndex + 1}/${totalCount}`
  const footer = isLastWindow && truncated ? [s().moreEvents] : []
  return [header, '', ...lines, ...footer, '', s().hintPressDetail].join('\n')
}

export function dayErrorScreenText(message: string): string {
  return [message, '', s().hintDoubleBack].join('\n')
}

export function upcomingLoadingScreenText(): string {
  return [s().upcomingLabel, s().loading].join('\n')
}

export function upcomingEmptyScreenText(): string {
  return [s().upcomingLabel, s().noEvents, '', s().hintDoubleBack].join('\n')
}

/**
 * lines(選択カーソルウィンドウ、最大3行)は事前にformatUpcomingEventLine + truncateForDisplayで整形し、
 * 選択中の1行だけ'> 'プレフィックスを付けた状態で渡されている前提(ホームメニューと同じ表現)。
 */
export function upcomingEventsScreenText(selectedIndex: number, totalCount: number, lines: string[], isLastWindow: boolean, truncated: boolean): string {
  const header = `${s().upcomingLabel} ${selectedIndex + 1}/${totalCount}`
  const footer = isLastWindow && truncated ? [s().moreEvents] : []
  return [header, '', ...lines, ...footer, '', s().hintPressDetail].join('\n')
}

export function errorScreenText(message: string): string {
  return [message, '', s().hintPressOrDoubleHome].join('\n')
}

// --- 予定詳細/編集/削除画面(eventIdは絶対に含めないこと) ---

export function eventDetailLoadingScreenText(): string {
  return [s().loading].join('\n')
}

/**
 * lines(タイトルを除く本文、最大EVENT_DETAIL_LINES_PER_PAGE行)は事前にbuildEventDetailLinesと
 * ページ分割で整形済みであること。eventIdはここでは一切参照しない(呼び出し側もtitle/整形済み文字列しか渡さない)。
 */
export function eventDetailScreenText(title: string, page: number, pageCount: number, lines: string[]): string {
  const header = pageCount > 1 ? `${truncateForDisplay(title, 40)} ${page + 1}/${pageCount}` : truncateForDisplay(title, 40)
  const hint = pageCount > 1 ? [s().hintSwipeMore, s().hintPressMenu, s().hintDoubleToList] : [s().hintPressMenu, s().hintDoubleToList]
  return [header, '', ...lines, '', ...hint].join('\n')
}

/** 詳細画面の単押しで開くアクションメニュー(編集/削除/一覧に戻る)。ホームメニューと同じカーソル表現。 */
export function eventDetailMenuScreenText(selectedIndex: number): string {
  const items = EVENT_DETAIL_MENU_ITEMS_BY_LOCALE[getActiveLocale()] ?? EVENT_DETAIL_MENU_ITEMS_BY_LOCALE.ja
  const lines = items.map((item, i) => (i === selectedIndex ? `> ${item}` : `  ${item}`))
  return [s().menu, '', ...lines, '', s().hintPressSelect, s().hintDoubleBack].join('\n')
}

export function eventDetailErrorScreenText(message: string): string {
  return [message, '', s().hintPressRetryAction, s().hintDoubleToList].join('\n')
}

/** 予定が他端末で更新/削除済みだった場合(404/409)専用。古い詳細を出し続けず、必ず一覧へ戻す。 */
export function eventGoneScreenText(): string {
  return [s().goneLine1, s().goneLine2, '', s().hintPressOrDoubleToList].join('\n')
}

export function deleteConfirmScreenText(title: string, whenText: string): string {
  return [truncateForDisplay(title, 40), whenText, '', s().deleteQuestion, '', s().hintPressDelete, s().hintDoubleCancel].join('\n')
}

export function deletingScreenText(): string {
  return [s().deleting, s().pleaseWait].join('\n')
}

/** 更新(PATCH)/削除(DELETE)の一時的な失敗(タイムアウト・通信エラー等)専用。conflictはeventGoneScreenTextを使う。 */
export function eventMutationErrorScreenText(message: string): string {
  return [message, '', s().hintPressRetryAction, s().hintDoubleToList].join('\n')
}

export function editRecordingScreenText(): string {
  return [s().editRecording, '', s().pressAgainToFinish, s().hintDoubleAbort].join('\n')
}

export function editCapturedScreenText(durationSec: number): string {
  const rounded = Math.max(1, Math.round(durationSec))
  return [s().editCaptured, s().duration(rounded), '', s().hintPressConfirm, s().hintDoubleRerecord].join('\n')
}

export function editAnalyzingScreenText(): string {
  return [s().editAnalyzing, s().pleaseWait, '', s().hintDoubleAbort].join('\n')
}

export function editNotUnderstoodScreenText(): string {
  return [s().editNotUnderstoodLine1, s().editNotUnderstoodLine2, '', s().hintPressRerecord, s().hintDoubleBackToEvent].join('\n')
}

export interface EditDiffLine {
  label: string
  before: string
  after: string
}

/** 実際に変更されたフィールドだけをbefore→afterで列挙する(diffは呼び出し側で計算済み)。 */
export function editConfirmScreenText(diff: EditDiffLine[]): string {
  const lines = diff.flatMap((d) => [`${d.label}:`, `${truncateForDisplay(d.before, 26)} → ${truncateForDisplay(d.after, 26)}`])
  return [s().editConfirmQuestion, '', ...lines, '', s().hintPressUpdate, s().hintDoubleCancel].join('\n')
}

export function editApplyingScreenText(): string {
  return [s().editApplying, s().pleaseWait].join('\n')
}

// --- Phase 2H: 製品用ペアリング画面 ---

export function notConnectedScreenText(): string {
  return [s().appName, s().notConnectedLine1, s().notConnectedLine2, '', s().hintPressStartPairing, s().hintDoubleExit].join('\n')
}

/** verificationUrlは短縮済み表示用の文字列であること前提(呼び出し側で整形)。 */
export function pairingScreenText(verificationUrl: string, userCode: string): string {
  return [s().openOnPhone, verificationUrl, userCode, '', s().waitingForConnection, s().hintDoubleAbort].join('\n')
}

export function pairingSuccessScreenText(): string {
  return [s().connected, '', s().hintPressToMenu].join('\n')
}

export function pairingErrorScreenText(kind: PairingErrorKind): string {
  return [s().pairingError[kind], '', s().hintPressOrDoubleReconnect].join('\n')
}

// --- 言語選択/診断画面 ---

/**
 * 選択肢の表記は常に固定(activeLocaleに関わらず"English"/"日本語"のまま)。どちらのロケールで
 * 見ていても両方の言語名がその言語自身の表記で見える必要があるため、STRINGS(ロケール別テーブル)
 * を経由せずここで直接定義する。
 */
export const LANGUAGE_OPTIONS: readonly [{ locale: Locale; label: string }, { locale: Locale; label: string }] = [
  { locale: 'en', label: 'English' },
  { locale: 'ja', label: '日本語' },
]

/** 呼び出し側(app.ts)がselectedIndexを現在のactiveLocaleに合わせて初期化することで、現在の選択言語を示す。 */
export function languageScreenText(selectedIndex: number): string {
  const lines = LANGUAGE_OPTIONS.map((option, i) => (i === selectedIndex ? `> ${option.label}` : `  ${option.label}`))
  return [s().languageTitle, '', ...lines, '', s().hintSwipeSelect, s().hintPressRun, s().hintDoubleDiagnostics].join('\n')
}

/**
 * navigator/document/Intl/bridgeの生値取得はapp.ts側の責務(このモジュールはvitest environment:'node'
 * で動くため直接参照しない)。deviceInfoStatus/glassesInfoStatusは"ok locale=..."/"fail"のような
 * 既に整形済みの短い文字列であること前提(値そのものではなくapp.ts側で安全に組み立て済み)。
 */
export interface LanguageDiagnosticsValues {
  navigatorLanguages: string
  navigatorLanguage: string
  documentLang: string
  intlLocale: string
  stored: string
  active: string
  deviceInfoStatus: string
  glassesInfoStatus: string
}

/** 実機診断専用の画面。secret/token/installId/sn等は一切含まない(渡されるのは言語タグ相当の文字列のみ)。 */
export function languageDiagnosticsScreenText(values: LanguageDiagnosticsValues): string {
  return [
    s().diagnosticsTitle,
    `${s().diagLabelNavLanguages}: ${truncateForDisplay(values.navigatorLanguages, 40)}`,
    `${s().diagLabelNavLanguage}: ${truncateForDisplay(values.navigatorLanguage, 40)}`,
    `${s().diagLabelDocLang}: ${truncateForDisplay(values.documentLang, 40)}`,
    `${s().diagLabelIntlLocale}: ${truncateForDisplay(values.intlLocale, 40)}`,
    `${s().diagLabelStored}: ${values.stored}`,
    `${s().diagLabelActive}: ${values.active}`,
    `${s().diagLabelDeviceInfo}: ${truncateForDisplay(values.deviceInfoStatus, 45)}`,
    `${s().diagLabelGlassesInfo}: ${truncateForDisplay(values.glassesInfoStatus, 45)}`,
    '',
    s().hintPressOrDoubleBack,
  ].join('\n')
}
