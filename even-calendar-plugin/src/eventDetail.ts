// バックエンドの /plugin/calendar-events/:eventId (GET) レスポンスを信頼せず、型・日時フォーマットを
// クライアント側でも独立に再検証する。eventIdは実際のGoogle event IDであり、常にメモリ上にのみ保持し、
// 画面表示にもbridge.setLocalStorageにも一切出さないこと(呼び出し側の責務)。
import { truncateForDisplay } from './screens'
import { formatAllDayWhen, monthDay } from './allDayDisplay'

export interface EventAttendee {
  email: string
  displayName: string | null
  responseStatus: string | null
}

export interface EventDetail {
  eventId: string
  title: string
  status: string
  allDay: boolean
  startLocal: string | null
  endLocal: string | null
  startDate: string | null
  endDateExclusive: string | null
  location: string | null
  description: string | null
  attendees: EventAttendee[] | null
  meetingUrl: string | null
  etag: string | null
}

const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const FIELD_DISPLAY_MAX_LENGTH = 60

function parseAttendee(raw: unknown): EventAttendee | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.email !== 'string' || r.email.length === 0) return null
  return {
    email: r.email,
    displayName: typeof r.displayName === 'string' ? r.displayName : null,
    responseStatus: typeof r.responseStatus === 'string' ? r.responseStatus : null,
  }
}

/** サーバーは値のないフィールドをキーごと省略する(空文字/nullは返さない)前提でパースする。 */
export function parseEventDetail(raw: unknown): EventDetail | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  if (typeof r.eventId !== 'string' || r.eventId.length === 0) return null
  if (typeof r.title !== 'string' || r.title.length === 0) return null
  if (typeof r.status !== 'string') return null
  if (typeof r.allDay !== 'boolean') return null

  let startLocal: string | null = null
  let endLocal: string | null = null
  let startDate: string | null = null
  let endDateExclusive: string | null = null

  if (r.allDay) {
    if (typeof r.startDate !== 'string' || !LOCAL_DATE_PATTERN.test(r.startDate)) return null
    if (typeof r.endDateExclusive !== 'string' || !LOCAL_DATE_PATTERN.test(r.endDateExclusive)) return null
    startDate = r.startDate
    endDateExclusive = r.endDateExclusive
  } else {
    if (r.startLocal !== undefined) {
      if (typeof r.startLocal !== 'string' || !LOCAL_DATETIME_PATTERN.test(r.startLocal)) return null
      startLocal = r.startLocal
    }
    if (r.endLocal !== undefined) {
      if (typeof r.endLocal !== 'string' || !LOCAL_DATETIME_PATTERN.test(r.endLocal)) return null
      endLocal = r.endLocal
    }
  }

  if (r.location !== undefined && typeof r.location !== 'string') return null
  if (r.description !== undefined && typeof r.description !== 'string') return null

  let attendees: EventAttendee[] | null = null
  if (r.attendees !== undefined) {
    if (!Array.isArray(r.attendees)) return null
    const parsed: EventAttendee[] = []
    for (const a of r.attendees) {
      const item = parseAttendee(a)
      if (!item) return null
      parsed.push(item)
    }
    attendees = parsed
  }

  if (r.meetingUrl !== undefined && typeof r.meetingUrl !== 'string') return null
  if (r.etag !== undefined && typeof r.etag !== 'string') return null

  return {
    eventId: r.eventId,
    title: r.title,
    status: r.status,
    allDay: r.allDay,
    startLocal,
    endLocal,
    startDate,
    endDateExclusive,
    location: typeof r.location === 'string' ? r.location : null,
    description: typeof r.description === 'string' ? r.description : null,
    attendees,
    meetingUrl: typeof r.meetingUrl === 'string' ? r.meetingUrl : null,
    etag: typeof r.etag === 'string' ? r.etag : null,
  }
}

/** 開始/終了/終日フラグをまとめた1行を作る。開始・終了ともに無ければnull(=行を出さない)。 */
export function formatEventDetailWhen(detail: EventDetail): string | null {
  if (detail.allDay) {
    if (!detail.startDate) return null
    return formatAllDayWhen(detail.startDate, detail.endDateExclusive)
  }

  if (!detail.startLocal && !detail.endLocal) return null
  if (detail.startLocal && detail.endLocal) {
    const sameDay = detail.startLocal.slice(0, 10) === detail.endLocal.slice(0, 10)
    const startTime = detail.startLocal.slice(11, 16)
    const endTime = detail.endLocal.slice(11, 16)
    if (sameDay) {
      return `${monthDay(detail.startLocal.slice(0, 10))} ${startTime}-${endTime}`
    }
    return `${monthDay(detail.startLocal.slice(0, 10))} ${startTime}〜${monthDay(detail.endLocal.slice(0, 10))} ${endTime}`
  }
  if (detail.startLocal) {
    return `${monthDay(detail.startLocal.slice(0, 10))} ${detail.startLocal.slice(11, 16)}〜`
  }
  const end = detail.endLocal as string
  return `〜${monthDay(end.slice(0, 10))} ${end.slice(11, 16)}`
}

function formatAttendeesLine(attendees: EventAttendee[]): string {
  const names = attendees.map((a) => a.displayName ?? a.email)
  return `参加者: ${names.join(', ')}`
}

/**
 * 詳細画面の本文行(タイトルを除く)を、値のある項目だけ順番に並べて作る。
 * 各行はG2の1コンテナ幅に収まるようtruncateForDisplayで丸める(eventId等の非表示フィールドは含まない)。
 */
export function buildEventDetailLines(detail: EventDetail): string[] {
  const lines: string[] = []

  const when = formatEventDetailWhen(detail)
  if (when) lines.push(when)

  if (detail.location) lines.push(truncateForDisplay(`場所: ${detail.location}`, FIELD_DISPLAY_MAX_LENGTH))
  if (detail.description) lines.push(truncateForDisplay(`メモ: ${detail.description}`, FIELD_DISPLAY_MAX_LENGTH))
  if (detail.attendees && detail.attendees.length > 0) {
    lines.push(truncateForDisplay(formatAttendeesLine(detail.attendees), FIELD_DISPLAY_MAX_LENGTH))
  }
  if (detail.meetingUrl) lines.push(truncateForDisplay(`会議URL: ${detail.meetingUrl}`, FIELD_DISPLAY_MAX_LENGTH))

  return lines
}
