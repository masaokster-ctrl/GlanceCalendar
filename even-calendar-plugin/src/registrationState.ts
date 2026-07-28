export type RegistrationState = 'idle' | 'registering' | 'checkingStatus' | 'completed' | 'failed' | 'cancelled'

export interface RegistrationContext {
  state: RegistrationState
  errorCode: string | null
}

export type RegistrationEvent =
  | { type: 'START' }
  | { type: 'CHECK_STATUS' }
  | { type: 'SUCCEEDED' }
  | { type: 'FAILED'; errorCode: string }
  | { type: 'CANCELLED' }
  | { type: 'RESET' }

export const initialRegistrationContext: RegistrationContext = { state: 'idle', errorCode: null }

/** Calendar登録ライフサイクルの純粋な状態遷移関数。fetchやブリッジ呼び出しは一切含まない。 */
export function registrationReducer(context: RegistrationContext, event: RegistrationEvent): RegistrationContext {
  switch (event.type) {
    case 'START':
      return { state: 'registering', errorCode: null }
    case 'CHECK_STATUS':
      return { state: 'checkingStatus', errorCode: null }
    case 'SUCCEEDED':
      return { state: 'completed', errorCode: null }
    case 'FAILED':
      return { state: 'failed', errorCode: event.errorCode }
    case 'CANCELLED':
      return { state: 'cancelled', errorCode: null }
    case 'RESET':
      return { state: 'idle', errorCode: null }
    default:
      return context
  }
}
