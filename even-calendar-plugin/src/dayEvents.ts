// バックエンドの /plugin/calendar-events/day レスポンスを信頼せず、型・enum値・日時フォーマットを
// クライアント側でも独立に再検証する。eventIdは詳細取得/更新/削除に使う実際のGoogle event ID
// (旧eventKeyから改称。ランダムな使い捨て値ではなく実IDのため、常にメモリ上にのみ保持し、
// 画面表示にもbridge.setLocalStorageにも一切出さないこと)。description等はこの型に存在しない。
import { truncateForDisplay } from './screens'
import {
  formatAllDayLinePrefixEn,
  formatContinuedFromPrevDayEn,
  formatContinuesToNextDayEn,
  formatOngoingLinePrefixEn,
} from './i18n/dateFormats'
import { getActiveLocale } from './i18n/locale'

export type DayKind = 'today' | 'tomorrow'

export interface DayEventItem {
  eventId: string
  title: string
  allDay: boolean
  startLocal: string | null
  endLocal: string | null
  startDate: string | null
  endDateExclusive: string | null
}

export interface DayEventsResult {
  schemaVersion: '1'
  day: DayKind
  dateLocal: string
  timeZone: 'Asia/Tokyo'
  events: DayEventItem[]
  truncated: boolean
}

const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const TITLE_DISPLAY_MAX_LENGTH = 20

export function parseDayEventItem(raw: unknown): DayEventItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  if (typeof r.eventId !== 'string' || r.eventId.length === 0) return null
  if (typeof r.title !== 'string' || r.title.length === 0) return null
  if (typeof r.allDay !== 'boolean') return null

  if (r.allDay) {
    if (typeof r.startDate !== 'string' || !LOCAL_DATE_PATTERN.test(r.startDate)) return null
    if (typeof r.endDateExclusive !== 'string' || !LOCAL_DATE_PATTERN.test(r.endDateExclusive)) return null
    return {
      eventId: r.eventId,
      title: r.title,
      allDay: true,
      startLocal: null,
      endLocal: null,
      startDate: r.startDate,
      endDateExclusive: r.endDateExclusive,
    }
  }

  const startLocal = typeof r.startLocal === 'string' && LOCAL_DATETIME_PATTERN.test(r.startLocal) ? r.startLocal : null
  const endLocal = typeof r.endLocal === 'string' && LOCAL_DATETIME_PATTERN.test(r.endLocal) ? r.endLocal : null
  return { eventId: r.eventId, title: r.title, allDay: false, startLocal, endLocal, startDate: null, endDateExclusive: null }
}

export function parseDayEventsResult(raw: unknown): DayEventsResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  if (r.schemaVersion !== '1') return null
  if (r.day !== 'today' && r.day !== 'tomorrow') return null
  if (typeof r.dateLocal !== 'string' || !LOCAL_DATE_PATTERN.test(r.dateLocal)) return null
  if (r.timeZone !== 'Asia/Tokyo') return null
  if (typeof r.truncated !== 'boolean') return null
  if (!Array.isArray(r.events)) return null

  const events: DayEventItem[] = []
  for (const raw of r.events) {
    const item = parseDayEventItem(raw)
    if (!item) return null
    events.push(item)
  }

  return { schemaVersion: '1', day: r.day, dateLocal: r.dateLocal, timeZone: 'Asia/Tokyo', events, truncated: r.truncated }
}

/** 終日予定を先に、時間指定予定は開始時刻の早い順に並べる(表示専用。サーバー応答の元の並び順は変更しない別配列を返す)。 */
export function sortEventsForDisplay(events: DayEventItem[]): DayEventItem[] {
  const allDay = events.filter((e) => e.allDay)
  const timed = events
    .filter((e) => !e.allDay)
    .slice()
    .sort((a, b) => {
      const aKey = a.startLocal ?? ''
      const bKey = b.startLocal ?? ''
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
    })
  return [...allDay, ...timed]
}

function timePart(localDateTime: string): string {
  return localDateTime.slice(11, 16)
}

function datePart(localDateTime: string): string {
  return localDateTime.slice(0, 10)
}

/**
 * 1件分の表示行を作る。終日予定は「終日 タイトル」、時間指定予定は「HH:mm-HH:mm タイトル」。
 * 問い合わせ日(dateLocal)をまたぐ時間指定予定は、前日から続く/翌日へ続く/全日をまたぐの3パターンを
 * 終日予定と区別できる文言で表す(「終日」という語は使わない)。
 */
export function formatDayEventLine(event: DayEventItem, dateLocal: string): string {
  const title = truncateForDisplay(event.title, TITLE_DISPLAY_MAX_LENGTH)
  const isEn = getActiveLocale() === 'en'

  if (event.allDay) {
    return `${isEn ? formatAllDayLinePrefixEn() : '終日'} ${title}`
  }

  if (!event.startLocal || !event.endLocal) {
    return title
  }

  const startsBeforeDay = datePart(event.startLocal) < dateLocal
  const endsAfterDay = datePart(event.endLocal) > dateLocal

  if (startsBeforeDay && endsAfterDay) {
    return `${isEn ? formatOngoingLinePrefixEn() : '継続中'} ${title}`
  }
  if (startsBeforeDay) {
    const prefix = isEn ? formatContinuedFromPrevDayEn(timePart(event.endLocal)) : `前日から-${timePart(event.endLocal)}`
    return `${prefix} ${title}`
  }
  if (endsAfterDay) {
    const prefix = isEn ? formatContinuesToNextDayEn(timePart(event.startLocal)) : `${timePart(event.startLocal)}-翌日へ`
    return `${prefix} ${title}`
  }
  return `${timePart(event.startLocal)}-${timePart(event.endLocal)} ${title}`
}
