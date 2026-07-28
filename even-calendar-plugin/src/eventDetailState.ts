import type { EventDetail } from './eventDetail'

export type EventDetailState = 'idle' | 'loading' | 'loaded' | 'error'
export type EventDetailErrorKind = 'not_found' | 'transient'

// 詳細画面の本文は日/直近リストと同じ3行ウィンドウでページ送りする(既存のページング表現の踏襲)。
export const EVENT_DETAIL_LINES_PER_PAGE = 3

export interface EventDetailContext {
  state: EventDetailState
  detail: EventDetail | null
  page: number
  errorKind: EventDetailErrorKind | null
}

export type EventDetailEvent =
  | { type: 'START' }
  | { type: 'SUCCEEDED'; detail: EventDetail }
  | { type: 'FAILED'; errorKind: EventDetailErrorKind }
  | { type: 'PAGE_UP'; pageCount: number }
  | { type: 'PAGE_DOWN'; pageCount: number }
  | { type: 'RESET' }

export const initialEventDetailContext: EventDetailContext = { state: 'idle', detail: null, page: 0, errorKind: null }

export function eventDetailPageCount(lineCount: number): number {
  return Math.max(1, Math.ceil(lineCount / EVENT_DETAIL_LINES_PER_PAGE))
}

/** 予定詳細取得ライフサイクルの純粋な状態遷移関数。fetchやブリッジ呼び出しは一切含まない。 */
export function eventDetailReducer(context: EventDetailContext, event: EventDetailEvent): EventDetailContext {
  switch (event.type) {
    case 'START':
      return { state: 'loading', detail: null, page: 0, errorKind: null }
    case 'SUCCEEDED':
      return { state: 'loaded', detail: event.detail, page: 0, errorKind: null }
    case 'FAILED':
      return { state: 'error', detail: null, page: 0, errorKind: event.errorKind }
    case 'PAGE_UP': {
      if (context.state !== 'loaded') return context
      return { ...context, page: Math.max(0, context.page - 1) }
    }
    case 'PAGE_DOWN': {
      if (context.state !== 'loaded') return context
      return { ...context, page: Math.min(event.pageCount - 1, context.page + 1) }
    }
    case 'RESET':
      return initialEventDetailContext
    default:
      return context
  }
}
