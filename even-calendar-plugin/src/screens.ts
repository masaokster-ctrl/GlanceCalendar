import { formatAllDayWhen } from './allDayDisplay'

export const HOME_MENU_ITEMS = ['予定を登録', '直近5件の予定', '今日の予定', '明日の予定'] as const
export const HOME_MENU_ITEM_COUNT = HOME_MENU_ITEMS.length
const HOME_MENU_WINDOW_SIZE = 3

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
  const total = HOME_MENU_ITEM_COUNT
  const start = windowStart(selectedIndex, total, HOME_MENU_WINDOW_SIZE)
  const visibleItems = HOME_MENU_ITEMS.slice(start, start + HOME_MENU_WINDOW_SIZE)
  const lines = visibleItems.map((item, i) => (start + i === selectedIndex ? `> ${item}` : `  ${item}`))
  const header = `Calendar with Gemini ${selectedIndex + 1}/${total}`
  return [header, '', ...lines, '', '上下スワイプ: 選択', '押す: 実行', '二度押し: 終了'].join('\n')
}

export function recordingScreenText(): string {
  return ['録音中...', '', 'もう一度押して終了', '二度押し: キャンセル'].join('\n')
}

export function capturedScreenText(durationSec: number): string {
  const rounded = Math.max(1, Math.round(durationSec))
  return ['音声を取得しました', `長さ: 約${rounded}秒`, '', '押す: 確認へ', '二度押し: やり直し'].join('\n')
}

export function tooShortScreenText(): string {
  return ['短すぎます', '', '押す/二度押し: ホーム'].join('\n')
}

const MAX_DISPLAY_LENGTH = 60

/** 576x288の1コンテナに安全に収まるよう、長い文字列は省略記号付きで切り詰める。HTMLとしては解釈しない(単純なtext)。 */
export function truncateForDisplay(text: string, maxLength: number = MAX_DISPLAY_LENGTH): string {
  if (text.length <= maxLength) return text
  return text.slice(0, Math.max(0, maxLength - 1)) + '…'
}

export function analyzingScreenText(): string {
  return ['解析中...', 'しばらくお待ちください', '', '二度押し: 中止'].join('\n')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** startLocal/endLocalは事前に app 側で妥当性検証済みであること前提のフォーマット関数。 */
export function formatCandidateWhen(
  start: { month: number; day: number; hour: number; minute: number },
  end: { hour: number; minute: number },
): string {
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
  return ['予定を確認', truncateForDisplay(title), whenText, '', '押す: 登録確認', '二度押し: 中止'].join('\n')
}

export function finalConfirmScreenText(title: string, whenText: string): string {
  return ['登録しますか?', truncateForDisplay(title), whenText, '', '押す: 登録', '二度押し: 中止'].join('\n')
}

export function registeringScreenText(): string {
  return ['登録中...', 'しばらくお待ちください'].join('\n')
}

export function checkingStatusScreenText(): string {
  return ['登録結果を', '確認しています', '', 'しばらくお待ちください'].join('\n')
}

export function registeredScreenText(whenText: string): string {
  return ['登録しました', whenText, '', '押す: ホーム'].join('\n')
}

export function clarificationScreenText(question: string): string {
  return ['確認が必要です', truncateForDisplay(question), '', '押す: 回答する', '二度押し: 中止'].join('\n')
}

export function notCalendarScreenText(): string {
  return ['予定の内容を', '話してください', '', '押す: やり直す', '二度押し: 中止'].join('\n')
}

export function followupReadyScreenText(): string {
  return ['回答を話してください', '', '押す: 録音開始', '二度押し: 中止'].join('\n')
}

export function followupRecordingScreenText(): string {
  return ['回答を録音中...', '', 'もう一度押して終了', '二度押し: 中止'].join('\n')
}

export function followupCapturedScreenText(durationSec: number): string {
  const rounded = Math.max(1, Math.round(durationSec))
  return ['回答を取得しました', `長さ: 約${rounded}秒`, '', '押す: 送信', '二度押し: やり直し'].join('\n')
}

const DAY_LABEL: Record<'today' | 'tomorrow', string> = {
  today: '今日の予定',
  tomorrow: '明日の予定',
}

export function dayLoadingScreenText(day: 'today' | 'tomorrow'): string {
  return [DAY_LABEL[day], '読み込み中...'].join('\n')
}

export function dayEmptyScreenText(day: 'today' | 'tomorrow'): string {
  return [DAY_LABEL[day], '予定はありません', '', '二度押し: 戻る'].join('\n')
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
  const header = `${DAY_LABEL[day]} ${selectedIndex + 1}/${totalCount}`
  const footer = isLastWindow && truncated ? ['ほかの予定があります'] : []
  return [header, '', ...lines, ...footer, '', '押す: 詳細を見る'].join('\n')
}

export function dayErrorScreenText(message: string): string {
  return [message, '', '二度押し: 戻る'].join('\n')
}

const UPCOMING_LABEL = '直近5件の予定'

export function upcomingLoadingScreenText(): string {
  return [UPCOMING_LABEL, '読み込み中...'].join('\n')
}

export function upcomingEmptyScreenText(): string {
  return [UPCOMING_LABEL, '予定はありません', '', '二度押し: 戻る'].join('\n')
}

/**
 * lines(選択カーソルウィンドウ、最大3行)は事前にformatUpcomingEventLine + truncateForDisplayで整形し、
 * 選択中の1行だけ'> 'プレフィックスを付けた状態で渡されている前提(ホームメニューと同じ表現)。
 */
export function upcomingEventsScreenText(selectedIndex: number, totalCount: number, lines: string[], isLastWindow: boolean, truncated: boolean): string {
  const header = `${UPCOMING_LABEL} ${selectedIndex + 1}/${totalCount}`
  const footer = isLastWindow && truncated ? ['ほかの予定があります'] : []
  return [header, '', ...lines, ...footer, '', '押す: 詳細を見る'].join('\n')
}

export function errorScreenText(message: string): string {
  return [message, '', '押す/二度押し: ホーム'].join('\n')
}

// --- 予定詳細/編集/削除画面(eventIdは絶対に含めないこと) ---

export function eventDetailLoadingScreenText(): string {
  return ['読み込み中...'].join('\n')
}

/**
 * lines(タイトルを除く本文、最大EVENT_DETAIL_LINES_PER_PAGE行)は事前にbuildEventDetailLinesと
 * ページ分割で整形済みであること。eventIdはここでは一切参照しない(呼び出し側もtitle/整形済み文字列しか渡さない)。
 */
export function eventDetailScreenText(title: string, page: number, pageCount: number, lines: string[]): string {
  const header = pageCount > 1 ? `${truncateForDisplay(title, 40)} ${page + 1}/${pageCount}` : truncateForDisplay(title, 40)
  const hint = pageCount > 1 ? ['上下スワイプ: 続き', '押す: メニュー', '二度押し: 一覧へ'] : ['押す: メニュー', '二度押し: 一覧へ']
  return [header, '', ...lines, '', ...hint].join('\n')
}

export const EVENT_DETAIL_MENU_ITEMS = ['編集', '削除', '一覧に戻る'] as const

/** 詳細画面の単押しで開くアクションメニュー(編集/削除/一覧に戻る)。ホームメニューと同じカーソル表現。 */
export function eventDetailMenuScreenText(selectedIndex: number): string {
  const lines = EVENT_DETAIL_MENU_ITEMS.map((item, i) => (i === selectedIndex ? `> ${item}` : `  ${item}`))
  return ['メニュー', '', ...lines, '', '押す: 選択', '二度押し: 戻る'].join('\n')
}

export function eventDetailErrorScreenText(message: string): string {
  return [message, '', '押す: 再試行', '二度押し: 一覧へ'].join('\n')
}

/** 予定が他端末で更新/削除済みだった場合(404/409)専用。古い詳細を出し続けず、必ず一覧へ戻す。 */
export function eventGoneScreenText(): string {
  return ['この予定は更新または', '削除されました', '', '押す/二度押し: 一覧へ'].join('\n')
}

export function deleteConfirmScreenText(title: string, whenText: string): string {
  return [truncateForDisplay(title, 40), whenText, '', 'この予定を削除しますか?', '', '押す: 削除する', '二度押し: キャンセル'].join('\n')
}

export function deletingScreenText(): string {
  return ['削除中...', 'しばらくお待ちください'].join('\n')
}

/** 更新(PATCH)/削除(DELETE)の一時的な失敗(タイムアウト・通信エラー等)専用。conflictはeventGoneScreenTextを使う。 */
export function eventMutationErrorScreenText(message: string): string {
  return [message, '', '押す: 再試行', '二度押し: 一覧へ'].join('\n')
}

export function editRecordingScreenText(): string {
  return ['変更内容を録音中...', '', 'もう一度押して終了', '二度押し: 中止'].join('\n')
}

export function editCapturedScreenText(durationSec: number): string {
  const rounded = Math.max(1, Math.round(durationSec))
  return ['変更内容を取得しました', `長さ: 約${rounded}秒`, '', '押す: 確認へ', '二度押し: 録音し直す'].join('\n')
}

export function editAnalyzingScreenText(): string {
  return ['変更内容を解析中...', 'しばらくお待ちください', '', '二度押し: 中止'].join('\n')
}

export function editNotUnderstoodScreenText(): string {
  return ['変更内容を', '認識できませんでした', '', '押す: 録音し直す', '二度押し: 予定に戻る'].join('\n')
}

export interface EditDiffLine {
  label: string
  before: string
  after: string
}

/** 実際に変更されたフィールドだけをbefore→afterで列挙する(diffは呼び出し側で計算済み)。 */
export function editConfirmScreenText(diff: EditDiffLine[]): string {
  const lines = diff.flatMap((d) => [`${d.label}:`, `${truncateForDisplay(d.before, 26)} → ${truncateForDisplay(d.after, 26)}`])
  return ['この内容で更新しますか?', '', ...lines, '', '押す: 更新する', '二度押し: キャンセル'].join('\n')
}

export function editApplyingScreenText(): string {
  return ['更新中...', 'しばらくお待ちください'].join('\n')
}

// --- Phase 2H: 製品用ペアリング画面 ---

export function notConnectedScreenText(): string {
  return ['Calendar with Gemini', 'Googleカレンダーとの', '接続が必要です', '', '押す: 接続を開始', '二度押し: 終了'].join('\n')
}

/** verificationUrlは短縮済み表示用の文字列であること前提(呼び出し側で整形)。 */
export function pairingScreenText(verificationUrl: string, userCode: string): string {
  return ['スマートフォンで開く', verificationUrl, userCode, '', '接続待ち...', '二度押し: 中止'].join('\n')
}

export function pairingSuccessScreenText(): string {
  return ['接続しました', '', '押す: メニューへ'].join('\n')
}

const PAIRING_ERROR_MESSAGES: Record<'expired' | 'communication_failure' | 'cancelled' | 'auth_failure', string> = {
  expired: '接続の有効期限が切れました',
  communication_failure: '通信に失敗しました',
  cancelled: '接続を中止しました',
  auth_failure: '認証に失敗しました',
}

export function pairingErrorScreenText(kind: 'expired' | 'communication_failure' | 'cancelled' | 'auth_failure'): string {
  return [PAIRING_ERROR_MESSAGES[kind], '', '押す/二度押し: 再接続'].join('\n')
}
