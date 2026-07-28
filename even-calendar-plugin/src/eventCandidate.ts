// バックエンドの /plugin/analyze-audio レスポンスを信頼せず、型・enum値・日時フォーマットを
// クライアント側でも独立に再検証する。発話の逐語文字起こしはこの型に存在しない。

export type ResultType = 'event_candidate' | 'needs_clarification' | 'not_calendar_request'
export type ClarificationField = 'title' | 'date' | 'start_time' | 'duration' | 'multiple'

export interface EventCandidateResult {
  schemaVersion: '1'
  resultType: ResultType
  title: string | null
  startLocal: string | null
  endLocal: string | null
  /** 終日予定(allDay===true)完成時のみ非null。YYYY-MM-DD。 */
  startDate: string | null
  /** Google Calendar API方式の排他的終了日(その日を含まない)。終日予定完成時のみ非null。
   *  利用者向け表示ではこの値を直接出さず、必ずallDayDisplay.tsのinclusiveEndDate/formatAllDayWhenを経由する。 */
  endDateExclusive: string | null
  timeZone: 'Asia/Tokyo'
  allDay: boolean
  clarificationField: ClarificationField | null
  clarificationQuestion: string | null
  assumptions: string[]
}

const RESULT_TYPES: readonly ResultType[] = ['event_candidate', 'needs_clarification', 'not_calendar_request']
const CLARIFICATION_FIELDS: readonly ClarificationField[] = ['title', 'date', 'start_time', 'duration', 'multiple']
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

/** サーバーはstartDate/endDateExclusiveを値の無い時キーごと省略しうる(null/undefinedどちらも「無し」として扱う)。 */
function isOmittableString(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === 'string'
}

export function parseEventCandidateResult(raw: unknown): EventCandidateResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  if (r.schemaVersion !== '1') return null
  if (typeof r.resultType !== 'string' || !RESULT_TYPES.includes(r.resultType as ResultType)) return null
  if (!isNullableString(r.title)) return null
  if (!isNullableString(r.startLocal)) return null
  if (!isNullableString(r.endLocal)) return null
  if (!isOmittableString(r.startDate)) return null
  if (!isOmittableString(r.endDateExclusive)) return null
  if (r.timeZone !== 'Asia/Tokyo') return null
  if (typeof r.allDay !== 'boolean') return null

  const clarificationField = r.clarificationField
  if (clarificationField !== null && clarificationField !== undefined) {
    if (typeof clarificationField !== 'string' || !CLARIFICATION_FIELDS.includes(clarificationField as ClarificationField)) {
      return null
    }
  }

  if (!isNullableString(r.clarificationQuestion)) return null
  if (!Array.isArray(r.assumptions) || !r.assumptions.every((a) => typeof a === 'string')) return null
  if (typeof r.startLocal === 'string' && !LOCAL_DATETIME_PATTERN.test(r.startLocal)) return null
  if (typeof r.endLocal === 'string' && !LOCAL_DATETIME_PATTERN.test(r.endLocal)) return null
  if (typeof r.startDate === 'string' && !LOCAL_DATE_PATTERN.test(r.startDate)) return null
  if (typeof r.endDateExclusive === 'string' && !LOCAL_DATE_PATTERN.test(r.endDateExclusive)) return null

  // 完成したevent_candidateのみ、allDayとフィールド構成の整合を厳密に検証する(未完成/他resultTypeは緩く許容)。
  if (r.resultType === 'event_candidate') {
    if (r.allDay) {
      if (r.startLocal !== null && r.startLocal !== undefined) return null
      if (r.endLocal !== null && r.endLocal !== undefined) return null
      if (typeof r.startDate !== 'string' || typeof r.endDateExclusive !== 'string') return null
      if (!(r.startDate < r.endDateExclusive)) return null
    } else {
      if (typeof r.startLocal !== 'string' || typeof r.endLocal !== 'string') return null
      if (r.startDate !== null && r.startDate !== undefined) return null
      if (r.endDateExclusive !== null && r.endDateExclusive !== undefined) return null
    }
  }

  return {
    schemaVersion: '1',
    resultType: r.resultType as ResultType,
    title: (r.title ?? null) as string | null,
    startLocal: (r.startLocal ?? null) as string | null,
    endLocal: (r.endLocal ?? null) as string | null,
    startDate: (typeof r.startDate === 'string' ? r.startDate : null),
    endDateExclusive: (typeof r.endDateExclusive === 'string' ? r.endDateExclusive : null),
    timeZone: 'Asia/Tokyo',
    allDay: r.allDay,
    clarificationField: (clarificationField ?? null) as ClarificationField | null,
    clarificationQuestion: (r.clarificationQuestion ?? null) as string | null,
    assumptions: r.assumptions as string[],
  }
}

export interface LocalDateTimeParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function parseLocalDateTime(value: string): LocalDateTimeParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (!m || !m[1] || !m[2] || !m[3] || !m[4] || !m[5] || !m[6]) return null
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  }
}

/** "YYYY-MM-DDTHH:mm:ss" は零埋め固定長なので辞書式比較がそのまま時系列比較として正しい。 */
export function nowLocalIsoTokyo(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}

/**
 * 終日候補(startDate/endDateExclusive、YYYY-MM-DD)の日付範囲を検証する。
 * サーバー側(isWithinAllDayBusinessRules)と同じ強さの既存ルール(過去日拒否・start<end)のみを適用し、
 * 新たな期間上限などの業務ルールはここでは追加しない。YYYY-MM-DDは零埋め固定長のため辞書式比較で正しい。
 */
function validateAllDayCandidateRange(startDate: string | null, endDateExclusive: string | null, nowLocal: string): boolean {
  if (!startDate || !endDateExclusive) return false
  if (!LOCAL_DATE_PATTERN.test(startDate) || !LOCAL_DATE_PATTERN.test(endDateExclusive)) return false
  const today = nowLocal.slice(0, 10)
  if (startDate < today) return false
  if (!(startDate < endDateExclusive)) return false
  return true
}

/**
 * サーバーが返したevent_candidateの日時を、G2に表示する前にクライアント側でも再検証する。
 * 不正フォーマット・過去日時・end<=startはすべて無効(需要clarificationへ倒すべき信号)として扱う。
 * event_candidate以外は常にtrue(このバリデーションの対象外)。終日(allDay===true)の場合は
 * startLocal/endLocalではなくstartDate/endDateExclusiveを検証する。
 */
export function validateEventCandidateTiming(result: EventCandidateResult, nowLocal: string): boolean {
  if (result.resultType !== 'event_candidate') return true
  if (result.allDay) return validateAllDayCandidateRange(result.startDate, result.endDateExclusive, nowLocal)
  if (!result.startLocal || !result.endLocal) return false
  if (!parseLocalDateTime(result.startLocal) || !parseLocalDateTime(result.endLocal)) return false
  if (result.startLocal < nowLocal) return false
  if (result.endLocal <= result.startLocal) return false
  return true
}

// --- /plugin/analyze-followup-audio 用(初回analyze-audioのschemaに"cancelled"を加えたもの) ---

export type FollowupResultType = 'event_candidate' | 'needs_clarification' | 'cancelled' | 'not_calendar_request'

export interface FollowupResult {
  schemaVersion: '1'
  resultType: FollowupResultType
  title: string | null
  startLocal: string | null
  endLocal: string | null
  startDate: string | null
  endDateExclusive: string | null
  timeZone: 'Asia/Tokyo'
  allDay: boolean
  clarificationField: ClarificationField | null
  clarificationQuestion: string | null
  assumptions: string[]
}

const FOLLOWUP_RESULT_TYPES: readonly FollowupResultType[] = [
  'event_candidate',
  'needs_clarification',
  'cancelled',
  'not_calendar_request',
]

export function parseFollowupResult(raw: unknown): FollowupResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  if (r.schemaVersion !== '1') return null
  if (typeof r.resultType !== 'string' || !FOLLOWUP_RESULT_TYPES.includes(r.resultType as FollowupResultType)) return null
  if (!isNullableString(r.title)) return null
  if (!isNullableString(r.startLocal)) return null
  if (!isNullableString(r.endLocal)) return null
  if (!isOmittableString(r.startDate)) return null
  if (!isOmittableString(r.endDateExclusive)) return null
  if (r.timeZone !== 'Asia/Tokyo') return null
  if (typeof r.allDay !== 'boolean') return null

  const clarificationField = r.clarificationField
  if (clarificationField !== null && clarificationField !== undefined) {
    if (typeof clarificationField !== 'string' || !CLARIFICATION_FIELDS.includes(clarificationField as ClarificationField)) {
      return null
    }
  }

  if (!isNullableString(r.clarificationQuestion)) return null
  if (!Array.isArray(r.assumptions) || !r.assumptions.every((a) => typeof a === 'string')) return null
  if (typeof r.startLocal === 'string' && !LOCAL_DATETIME_PATTERN.test(r.startLocal)) return null
  if (typeof r.endLocal === 'string' && !LOCAL_DATETIME_PATTERN.test(r.endLocal)) return null
  if (typeof r.startDate === 'string' && !LOCAL_DATE_PATTERN.test(r.startDate)) return null
  if (typeof r.endDateExclusive === 'string' && !LOCAL_DATE_PATTERN.test(r.endDateExclusive)) return null

  if (r.resultType === 'event_candidate') {
    if (r.allDay) {
      if (r.startLocal !== null && r.startLocal !== undefined) return null
      if (r.endLocal !== null && r.endLocal !== undefined) return null
      if (typeof r.startDate !== 'string' || typeof r.endDateExclusive !== 'string') return null
      if (!(r.startDate < r.endDateExclusive)) return null
    } else {
      if (typeof r.startLocal !== 'string' || typeof r.endLocal !== 'string') return null
      if (r.startDate !== null && r.startDate !== undefined) return null
      if (r.endDateExclusive !== null && r.endDateExclusive !== undefined) return null
    }
  }

  return {
    schemaVersion: '1',
    resultType: r.resultType as FollowupResultType,
    title: (r.title ?? null) as string | null,
    startLocal: (r.startLocal ?? null) as string | null,
    endLocal: (r.endLocal ?? null) as string | null,
    startDate: (typeof r.startDate === 'string' ? r.startDate : null),
    endDateExclusive: (typeof r.endDateExclusive === 'string' ? r.endDateExclusive : null),
    timeZone: 'Asia/Tokyo',
    allDay: r.allDay,
    clarificationField: (clarificationField ?? null) as ClarificationField | null,
    clarificationQuestion: (r.clarificationQuestion ?? null) as string | null,
    assumptions: r.assumptions as string[],
  }
}

/** event_candidate以外は常にtrue。initialのvalidateEventCandidateTimingと同じロジック(終日はstartDate/endDateExclusiveを検証)。 */
export function validateFollowupCandidateTiming(result: FollowupResult, nowLocal: string): boolean {
  if (result.resultType !== 'event_candidate') return true
  if (result.allDay) return validateAllDayCandidateRange(result.startDate, result.endDateExclusive, nowLocal)
  if (!result.startLocal || !result.endLocal) return false
  if (!parseLocalDateTime(result.startLocal) || !parseLocalDateTime(result.endLocal)) return false
  if (result.startLocal < nowLocal) return false
  if (result.endLocal <= result.startLocal) return false
  return true
}
