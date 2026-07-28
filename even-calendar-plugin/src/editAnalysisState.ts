import type { EditInstructionResult } from './editInstruction'

export type EditAnalysisState = 'idle' | 'analyzing' | 'succeeded' | 'cancelled' | 'error'

export interface EditAnalysisContext {
  state: EditAnalysisState
  result: EditInstructionResult | null
  errorCode: string | null
}

export type EditAnalysisEvent =
  | { type: 'START' }
  | { type: 'SUCCEEDED'; result: EditInstructionResult }
  | { type: 'FAILED'; errorCode: string }
  | { type: 'CANCELLED' }
  | { type: 'RESET' }

export const initialEditAnalysisContext: EditAnalysisContext = { state: 'idle', result: null, errorCode: null }

/**
 * 音声編集指示の解析ライフサイクルの純粋な状態遷移関数(analysisState.tsと同形)。fetchやブリッジ呼び出しは
 * 一切含まない。EditInstructionResultはEventCandidateResultとは形状が異なるため、既存のanalysisReducerを
 * 使い回すのではなく専用の型で持つ。
 */
export function editAnalysisReducer(context: EditAnalysisContext, event: EditAnalysisEvent): EditAnalysisContext {
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
