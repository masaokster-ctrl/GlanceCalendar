// 英語日時表示フォーマットの一元化モジュール。
// ICU変動を避けるため Intl.DateTimeFormat のロケール既定パターンは使わず、MONTH_ABBR_EN による
// 明示組み立てのみで構築する(vitestは environment: 'node' でICUデータが環境依存になり得るため)。
// eventCandidate.ts の Intl.DateTimeFormat('en-CA', ...) はタイムゾーン算出専用の別関数であり、
// こことは無関係(表示テキストではない)。
//
// 日付の1日減算(排他的終了日→包含最終日)は allDayDisplay.ts の inclusiveEndDate() の唯一の
// 呼び出しのみを経由する。このモジュールは常に「呼び出し側で変換済みの」YYYY-MM-DD文字列を受け取り、
// 新しい-1日計算を一切行わない。
//
// AR6: 日付と時刻/ラベルの間はカンマ区切り("All day, Jul 30" / "Jul 23, 15:00-16:00")。
// 非ASCII記号(全角チルダ〜、enダッシュ)はG2フォント欠字リスクを避けるため使わず、
// 範囲区切りは常に半角ハイフン(-)を使う。

export const MONTH_ABBR_EN = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function monthAbbr(month: number): string {
  return MONTH_ABBR_EN[month - 1] ?? ''
}

/** "YYYY-MM-DD" -> "Jul 30" */
export function monthDayEn(dateStr: string): string {
  const month = Number(dateStr.slice(5, 7))
  const day = Number(dateStr.slice(8, 10))
  return `${monthAbbr(month)} ${day}`
}

/** "YYYY-MM-DD" -> "Jul 23, 2027" (upcoming一覧の年跨ぎプレフィックス専用) */
export function monthDayYearEn(dateStr: string): string {
  const year = Number(dateStr.slice(0, 4))
  return `${monthDayEn(dateStr)}, ${year}`
}

/** 候補確認(時間指定)/詳細・同日: "Jul 23, 15:00-16:00" */
export function formatTimeRangeEn(monthDay: string, startTime: string, endTime: string): string {
  return `${monthDay}, ${startTime}-${endTime}`
}

/** 候補確認(時間指定)を数値要素から組み立てる。screens.ts の formatCandidateWhen(ja版)と同じ入力形。 */
export function formatCandidateWhenEn(
  start: { month: number; day: number; hour: number; minute: number },
  end: { hour: number; minute: number },
): string {
  const monthDay = `${monthAbbr(start.month)} ${start.day}`
  return formatTimeRangeEn(monthDay, `${pad2(start.hour)}:${pad2(start.minute)}`, `${pad2(end.hour)}:${pad2(end.minute)}`)
}

/** 詳細・日跨ぎ: "Jul 30, 22:00 to Jul 31, 02:00" */
export function formatCrossDayRangeEn(startMonthDay: string, startTime: string, endMonthDay: string, endTime: string): string {
  return `${startMonthDay}, ${startTime} to ${endMonthDay}, ${endTime}`
}

/** 詳細・開始のみ: "From Jul 30, 10:00" */
export function formatStartOnlyEn(monthDay: string, time: string): string {
  return `From ${monthDay}, ${time}`
}

/** 詳細・終了のみ: "Until Jul 30, 10:00" */
export function formatEndOnlyEn(monthDay: string, time: string): string {
  return `Until ${monthDay}, ${time}`
}

/** 終日・単日: "All day, Jul 30" */
export function formatAllDaySingleEn(monthDay: string): string {
  return `All day, ${monthDay}`
}

/**
 * 終日・複数日(月/年跨ぎ含む): "All day, Aug 3 - Aug 5"
 * 呼び出し側が既に排他的終了日→包含最終日へ変換した YYYY-MM-DD を渡すこと
 * (endDateExclusiveをそのまま渡してはならない)。
 */
export function formatAllDayRangeEn(startMonthDay: string, endMonthDayInclusive: string): string {
  return `All day, ${startMonthDay} - ${endMonthDayInclusive}`
}

// --- 一覧行(dayEvents.formatDayEventLine)用。日本語版と同じく「終日」と日跨ぎを必ず区別できる語にする
// (英語でも日跨ぎに "All day" を使わないこと)。区切りは半角ハイフンのみ。 ---

/** 一覧・終日行の接頭辞: "All day <title>" */
export function formatAllDayLinePrefixEn(): string {
  return 'All day'
}

/** 問い合わせ日の前後どちらにもまたがる(終日ではない)予定: "Ongoing <title>" */
export function formatOngoingLinePrefixEn(): string {
  return 'Ongoing'
}

/** 前日から続き当日 HH:mm に終わる予定: "From prev day-16:00" */
export function formatContinuedFromPrevDayEn(endTime: string): string {
  return `From prev day-${endTime}`
}

/** 当日 HH:mm に始まり翌日へ続く予定: "22:00-next day" */
export function formatContinuesToNextDayEn(startTime: string): string {
  return `${startTime}-next day`
}
