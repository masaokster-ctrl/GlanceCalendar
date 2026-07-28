// バックエンドの /plugin/calendar-events/upcoming レスポンスを信頼せず、型・enum値・日時フォーマットを
// クライアント側でも独立に再検証する。eventId(実際のGoogle event ID)はDayEventItem経由で
// 保持するが、メモリ上のみに留め、画面表示にもbridge.setLocalStorageにも一切出さないこと。
import { parseDayEventItem, TITLE_DISPLAY_MAX_LENGTH, type DayEventItem } from './dayEvents'
import { truncateForDisplay } from './screens'

export interface UpcomingEventsResult {
  schemaVersion: '1'
  mode: 'upcoming'
  timeZone: 'Asia/Tokyo'
  events: DayEventItem[]
  truncated: boolean
}

export function parseUpcomingEventsResult(raw: unknown): UpcomingEventsResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  if (r.schemaVersion !== '1') return null
  if (r.mode !== 'upcoming') return null
  if (r.timeZone !== 'Asia/Tokyo') return null
  if (typeof r.truncated !== 'boolean') return null
  if (!Array.isArray(r.events)) return null

  const events: DayEventItem[] = []
  for (const raw of r.events) {
    const item = parseDayEventItem(raw)
    if (!item) return null
    events.push(item)
  }

  return { schemaVersion: '1', mode: 'upcoming', timeZone: 'Asia/Tokyo', events, truncated: r.truncated }
}

function datePrefix(dateStr: string, referenceYear: number): string {
  const year = Number(dateStr.slice(0, 4))
  const month = Number(dateStr.slice(5, 7))
  const day = Number(dateStr.slice(8, 10))
  return year === referenceYear ? `${month}/${day}` : `${year}/${month}/${day}`
}

/**
 * 直近5件用の表示行を作る。今日/明日/それ以降を横断するため、必ず日付を先頭に付ける
 * (「M/D HH:mm-HH:mm タイトル」「M/D 終日 タイトル」)。年をまたぐ場合は「YYYY/M/D」形式にする。
 */
export function formatUpcomingEventLine(event: DayEventItem, referenceYear: number): string {
  const title = truncateForDisplay(event.title, TITLE_DISPLAY_MAX_LENGTH)

  if (event.allDay && event.startDate) {
    return `${datePrefix(event.startDate, referenceYear)} 終日 ${title}`
  }

  if (event.startLocal) {
    const date = datePrefix(event.startLocal.slice(0, 10), referenceYear)
    const startTime = event.startLocal.slice(11, 16)
    const endTime = event.endLocal ? event.endLocal.slice(11, 16) : null
    return endTime ? `${date} ${startTime}-${endTime} ${title}` : `${date} ${startTime} ${title}`
  }

  return title
}
