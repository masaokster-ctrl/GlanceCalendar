export type PairingErrorKind = 'expired' | 'communication_failure' | 'cancelled' | 'auth_failure'

export type PairingState = 'idle' | 'starting' | 'waitingApproval' | 'exchanging' | 'success' | 'error'

export interface PairingContext {
  state: PairingState
  pairingId: string | null
  verificationUrl: string | null
  userCode: string | null
  pollIntervalSeconds: number | null
  errorKind: PairingErrorKind | null
}

export type PairingEvent =
  | { type: 'START' }
  | { type: 'STARTED'; pairingId: string; verificationUrl: string; userCode: string; pollIntervalSeconds: number }
  | { type: 'START_FAILED' }
  | { type: 'APPROVED' }
  | { type: 'EXCHANGE_SUCCEEDED' }
  | { type: 'EXPIRED' }
  | { type: 'CANCELLED' }
  | { type: 'AUTH_FAILED' }
  | { type: 'COMMUNICATION_FAILED' }
  | { type: 'RESET' }

export const initialPairingContext: PairingContext = {
  state: 'idle',
  pairingId: null,
  verificationUrl: null,
  userCode: null,
  pollIntervalSeconds: null,
  errorKind: null,
}

function toError(context: PairingContext, errorKind: PairingErrorKind): PairingContext {
  return { ...context, state: 'error', errorKind }
}

/** ペアリング画面遷移の純粋な状態遷移関数。ブリッジ呼び出しやfetch・タイマーを一切含まない。 */
export function pairingReducer(context: PairingContext, event: PairingEvent): PairingContext {
  switch (event.type) {
    case 'START':
      return { ...initialPairingContext, state: 'starting' }
    case 'STARTED':
      return {
        state: 'waitingApproval',
        pairingId: event.pairingId,
        verificationUrl: event.verificationUrl,
        userCode: event.userCode,
        pollIntervalSeconds: event.pollIntervalSeconds,
        errorKind: null,
      }
    case 'START_FAILED':
      return toError(context, 'communication_failure')
    case 'APPROVED':
      return { ...context, state: 'exchanging' }
    case 'EXCHANGE_SUCCEEDED':
      return { ...context, state: 'success', errorKind: null }
    case 'EXPIRED':
      return toError(context, 'expired')
    case 'CANCELLED':
      return toError(context, 'cancelled')
    case 'AUTH_FAILED':
      return toError(context, 'auth_failure')
    case 'COMMUNICATION_FAILED':
      return toError(context, 'communication_failure')
    case 'RESET':
      return initialPairingContext
    default:
      return context
  }
}
