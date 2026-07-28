import type { DayEventItem } from './dayEvents'

export type UpcomingEventsState = 'idle' | 'loading' | 'loaded' | 'empty' | 'error'

// ホームメニューと同じ3件ウィンドウの選択カーソル方式で使う表示件数(旧: 1ページあたりの件数)。
export const UPCOMING_EVENTS_PER_PAGE = 3

export interface UpcomingEventsContext {
  state: UpcomingEventsState
  events: DayEventItem[]
  truncated: boolean
  selectedIndex: number
  errorCode: string | null
}

export type UpcomingEventsEvent =
  | { type: 'START' }
  | { type: 'SUCCEEDED'; events: DayEventItem[]; truncated: boolean }
  | { type: 'FAILED'; errorCode: string }
  | { type: 'SELECT_UP' }
  | { type: 'SELECT_DOWN' }
  | { type: 'RESET' }

export const initialUpcomingEventsContext: UpcomingEventsContext = {
  state: 'idle',
  events: [],
  truncated: false,
  selectedIndex: 0,
  errorCode: null,
}

/**
 * 直近5件取得ライフサイクルの純粋な状態遷移関数。fetchやブリッジ呼び出しは一切含まない。
 * selectedIndexは(旧pageと違い)全件を通した0始まりの選択位置。表示ウィンドウの計算はscreens側で行う。
 */
export function upcomingEventsReducer(context: UpcomingEventsContext, event: UpcomingEventsEvent): UpcomingEventsContext {
  switch (event.type) {
    case 'START':
      return { state: 'loading', events: [], truncated: false, selectedIndex: 0, errorCode: null }
    case 'SUCCEEDED':
      return {
        state: event.events.length === 0 ? 'empty' : 'loaded',
        events: event.events,
        truncated: event.truncated,
        selectedIndex: 0,
        errorCode: null,
      }
    case 'FAILED':
      return { state: 'error', events: [], truncated: false, selectedIndex: 0, errorCode: event.errorCode }
    case 'SELECT_UP': {
      if (context.state !== 'loaded') return context
      return { ...context, selectedIndex: Math.max(0, context.selectedIndex - 1) }
    }
    case 'SELECT_DOWN': {
      if (context.state !== 'loaded') return context
      return { ...context, selectedIndex: Math.min(context.events.length - 1, context.selectedIndex + 1) }
    }
    case 'RESET':
      return initialUpcomingEventsContext
    default:
      return context
  }
}
