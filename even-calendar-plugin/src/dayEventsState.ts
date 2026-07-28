import type { DayEventItem, DayKind } from './dayEvents'

export type DayEventsState = 'idle' | 'loading' | 'loaded' | 'empty' | 'error'

// ホームメニューと同じ3件ウィンドウの選択カーソル方式で使う表示件数(旧: 1ページあたりの件数)。
export const DAY_EVENTS_PER_PAGE = 3

export interface DayEventsContext {
  state: DayEventsState
  day: DayKind | null
  dateLocal: string | null
  events: DayEventItem[]
  truncated: boolean
  selectedIndex: number
  errorCode: string | null
}

export type DayEventsEvent =
  | { type: 'START'; day: DayKind }
  | { type: 'SUCCEEDED'; dateLocal: string; events: DayEventItem[]; truncated: boolean }
  | { type: 'FAILED'; errorCode: string }
  | { type: 'SELECT_UP' }
  | { type: 'SELECT_DOWN' }
  | { type: 'RESET' }

export const initialDayEventsContext: DayEventsContext = {
  state: 'idle',
  day: null,
  dateLocal: null,
  events: [],
  truncated: false,
  selectedIndex: 0,
  errorCode: null,
}

/**
 * 今日/明日の予定取得ライフサイクルの純粋な状態遷移関数。fetchやブリッジ呼び出しは一切含まない。
 * selectedIndexは(旧pageと違い)全件を通した0始まりの選択位置。表示ウィンドウの計算はscreens側で行う。
 */
export function dayEventsReducer(context: DayEventsContext, event: DayEventsEvent): DayEventsContext {
  switch (event.type) {
    case 'START':
      return { state: 'loading', day: event.day, dateLocal: null, events: [], truncated: false, selectedIndex: 0, errorCode: null }
    case 'SUCCEEDED':
      return {
        state: event.events.length === 0 ? 'empty' : 'loaded',
        day: context.day,
        dateLocal: event.dateLocal,
        events: event.events,
        truncated: event.truncated,
        selectedIndex: 0,
        errorCode: null,
      }
    case 'FAILED':
      return { state: 'error', day: context.day, dateLocal: null, events: [], truncated: false, selectedIndex: 0, errorCode: event.errorCode }
    case 'SELECT_UP': {
      if (context.state !== 'loaded') return context
      return { ...context, selectedIndex: Math.max(0, context.selectedIndex - 1) }
    }
    case 'SELECT_DOWN': {
      if (context.state !== 'loaded') return context
      return { ...context, selectedIndex: Math.min(context.events.length - 1, context.selectedIndex + 1) }
    }
    case 'RESET':
      return initialDayEventsContext
    default:
      return context
  }
}
