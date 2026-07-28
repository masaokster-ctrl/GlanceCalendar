// PATCH(編集の確定適用)とDELETEはどちらも「実行中 → 成功なら即座に呼び出し側で次画面へ/失敗ならconflictか
// transientかで分岐」という同じライフサイクルを持つため、1つの小さな状態機械を両方で使い回す
// (recordingReducerを初回録音とフォローアップ録音の両方で使い回すのと同じ考え方)。
export type EventMutationState = 'idle' | 'inProgress' | 'error'
export type EventMutationErrorKind = 'conflict' | 'transient'

export interface EventMutationContext {
  state: EventMutationState
  errorKind: EventMutationErrorKind | null
}

export type EventMutationEvent = { type: 'START' } | { type: 'FAILED'; errorKind: EventMutationErrorKind } | { type: 'RESET' }

export const initialEventMutationContext: EventMutationContext = { state: 'idle', errorKind: null }

export function eventMutationReducer(context: EventMutationContext, event: EventMutationEvent): EventMutationContext {
  switch (event.type) {
    case 'START':
      return { state: 'inProgress', errorKind: null }
    case 'FAILED':
      return { state: 'error', errorKind: event.errorKind }
    case 'RESET':
      return initialEventMutationContext
    default:
      return context
  }
}
