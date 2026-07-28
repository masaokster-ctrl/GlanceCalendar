import type { EventCandidateResult } from './eventCandidate'

export type AnalysisState = 'idle' | 'analyzing' | 'succeeded' | 'cancelled' | 'error'

export interface AnalysisContext {
  state: AnalysisState
  result: EventCandidateResult | null
  errorCode: string | null
}

export type AnalysisEvent =
  | { type: 'START' }
  | { type: 'SUCCEEDED'; result: EventCandidateResult }
  | { type: 'FAILED'; errorCode: string }
  | { type: 'CANCELLED' }
  | { type: 'RESET' }

export const initialAnalysisContext: AnalysisContext = { state: 'idle', result: null, errorCode: null }

/** 音声解析ライフサイクルの純粋な状態遷移関数。fetchやブリッジ呼び出しは一切含まない。 */
export function analysisReducer(context: AnalysisContext, event: AnalysisEvent): AnalysisContext {
  switch (event.type) {
    case 'START':
      return { state: 'analyzing', result: null, errorCode: null }
    case 'SUCCEEDED':
      return { state: 'succeeded', result: event.result, errorCode: null }
    case 'FAILED':
      return { state: 'error', result: null, errorCode: event.errorCode }
    case 'CANCELLED':
      return { state: 'cancelled', result: null, errorCode: null }
    case 'RESET':
      return { state: 'idle', result: null, errorCode: null }
    default:
      return context
  }
}
