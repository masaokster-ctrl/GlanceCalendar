// 終日予定の「排他的終了日(endDateExclusive, Google Calendar API方式) → 利用者向け包含最終日」変換を
// プラグイン全体で唯一ここでのみ行う。確認画面・成功画面・一覧・詳細は必ずこのモジュールの関数を経由し、
// 各画面で個別に「-1日」計算を書かないこと(1日ズレのバグを防ぐための唯一の変換点)。
// UTC基準のカレンダー日算術(DSTの影響を受けない)で、文字列の直接加工や固定ミリ秒演算は行わない。

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** "M/D" 形式の短い表示(確認画面・一覧・詳細で共通)。 */
export function monthDay(dateStr: string): string {
  return `${Number(dateStr.slice(5, 7))}/${Number(dateStr.slice(8, 10))}`
}

/**
 * endDateExclusive(排他的終了日、その日を含まない)から、利用者向けの包含最終日(YYYY-MM-DD)を求める。
 * 例: startDate=2026-08-03, endDateExclusive=2026-08-06 の終日予定 → 包含最終日は2026-08-05。
 * このendDateExclusiveをそのまま最終日として表示してはならない。
 */
export function inclusiveEndDate(endDateExclusive: string): string {
  const y = Number(endDateExclusive.slice(0, 4))
  const m = Number(endDateExclusive.slice(5, 7))
  const d = Number(endDateExclusive.slice(8, 10))
  const prev = new Date(Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000)
  return `${prev.getUTCFullYear()}-${pad2(prev.getUTCMonth() + 1)}-${pad2(prev.getUTCDate())}`
}

/**
 * 終日予定の確認/成功/詳細画面共通の短い表示テキストを作る。
 * 単日(startDate===包含最終日、またはendDateExclusiveが無い)は「終日 M/D」、
 * 複数日は「終日 M/D〜M/D」(排他的終了日をそのまま最終日として出さない)。
 */
export function formatAllDayWhen(startDate: string, endDateExclusive: string | null): string {
  const endInclusive = endDateExclusive ? inclusiveEndDate(endDateExclusive) : startDate
  if (endInclusive <= startDate) return `終日 ${monthDay(startDate)}`
  return `終日 ${monthDay(startDate)}〜${monthDay(endInclusive)}`
}

export function isValidLocalDate(value: string): boolean {
  return LOCAL_DATE_PATTERN.test(value)
}

export { LOCAL_DATE_PATTERN }
