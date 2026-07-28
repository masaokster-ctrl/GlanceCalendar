export type RecordingState = 'idle' | 'starting' | 'recording' | 'stopping' | 'captured' | 'cancelled' | 'error'

export interface RecordingContext {
  state: RecordingState
  durationSec: number | null
  errorCode: string | null
}

export type RecordingEvent =
  | { type: 'START' }
  | { type: 'STARTED' }
  | { type: 'START_FAILED'; errorCode: string }
  | { type: 'STOP' }
  | { type: 'STOPPED'; durationSec: number }
  | { type: 'STOP_FAILED'; errorCode: string }
  | { type: 'CANCEL' }
  | { type: 'CANCELLED' }
  | { type: 'RESET' }
  | { type: 'ERROR'; errorCode: string }

export const initialRecordingContext: RecordingContext = { state: 'idle', durationSec: null, errorCode: null }

/** 録音ライフサイクルの純粋な状態遷移関数。ブリッジ呼び出しやI/Oを一切含まない。 */
export function recordingReducer(context: RecordingContext, event: RecordingEvent): RecordingContext {
  switch (event.type) {
    case 'START':
      return { state: 'starting', durationSec: null, errorCode: null }
    case 'STARTED':
      return { state: 'recording', durationSec: null, errorCode: null }
    case 'START_FAILED':
      return { state: 'error', durationSec: null, errorCode: event.errorCode }
    case 'STOP':
      return { state: 'stopping', durationSec: null, errorCode: null }
    case 'STOPPED':
      return { state: 'captured', durationSec: event.durationSec, errorCode: null }
    case 'STOP_FAILED':
      return { state: 'error', durationSec: null, errorCode: event.errorCode }
    case 'CANCEL':
      return { state: 'stopping', durationSec: null, errorCode: null }
    case 'CANCELLED':
      return { state: 'cancelled', durationSec: null, errorCode: null }
    case 'RESET':
      return { state: 'idle', durationSec: null, errorCode: null }
    case 'ERROR':
      return { state: 'error', durationSec: null, errorCode: event.errorCode }
    default:
      return context
  }
}
