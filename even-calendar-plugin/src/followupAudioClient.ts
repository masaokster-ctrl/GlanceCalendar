import { parseFollowupResult, type FollowupResult } from './eventCandidate'

export type AnalyzeFollowupOutcome =
  | {
      kind: 'success'
      requestId: string
      conversationId: string
      result: FollowupResult
      candidateId: string | null
      turn: number | null
      maxTurns: number | null
    }
  | { kind: 'aborted' }
  | { kind: 'auth_failed' }
  | { kind: 'conversation_expired' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'failed' }

export interface AnalyzeFollowupParams {
  wav: Uint8Array
  baseUrl: string
  sessionToken: string
  installId: string
  requestId: string
  conversationId: string
  signal: AbortSignal
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 35_000

/** TS 5.7+ の Uint8Array<ArrayBufferLike> をfetchのBodyInit(素のArrayBuffer)に安全に渡すためのコピー。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/**
 * 追加入力(follow-up)のWAVを認証付きでバックエンドへ送信する。自動リトライは行わない。
 * 初回録音のPCM/WAVとは完全に分離されたバッファを渡すこと(呼び出し側の責務)。
 */
export async function analyzeFollowupAudio(params: AnalyzeFollowupParams): Promise<AnalyzeFollowupOutcome> {
  if (params.signal.aborted) {
    return { kind: 'aborted' }
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchController = new AbortController()
  const timeoutTimer = setTimeout(() => fetchController.abort(), timeoutMs)
  const onExternalAbort = (): void => fetchController.abort()
  params.signal.addEventListener('abort', onExternalAbort)

  const cleanup = (): void => {
    clearTimeout(timeoutTimer)
    params.signal.removeEventListener('abort', onExternalAbort)
  }

  let response: Response
  try {
    response = await fetch(`${params.baseUrl}/plugin/analyze-followup-audio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        Authorization: `Bearer ${params.sessionToken}`,
        'X-Install-Id': params.installId,
        'X-Request-Id': params.requestId,
        'X-Conversation-Id': params.conversationId,
      },
      body: toArrayBuffer(params.wav),
      signal: fetchController.signal,
    })
  } catch {
    cleanup()
    if (params.signal.aborted) {
      return { kind: 'aborted' }
    }
    if (fetchController.signal.aborted) {
      return { kind: 'timeout' }
    }
    return { kind: 'network_error' }
  }
  cleanup()

  if (params.signal.aborted) {
    return { kind: 'aborted' }
  }

  if (response.status === 401 || response.status === 403) return { kind: 'auth_failed' }
  if (response.status === 410) return { kind: 'conversation_expired' }
  if (response.status === 504) return { kind: 'timeout' }
  if (!response.ok) return { kind: 'failed' }

  const data: unknown = await response.json().catch(() => null)
  if (typeof data !== 'object' || data === null) return { kind: 'failed' }

  const body = data as {
    requestId?: unknown
    conversationId?: unknown
    result?: unknown
    candidateId?: unknown
    turn?: unknown
    maxTurns?: unknown
  }
  if (typeof body.requestId !== 'string' || typeof body.conversationId !== 'string') return { kind: 'failed' }

  const result = parseFollowupResult(body.result)
  if (!result) return { kind: 'failed' }

  return {
    kind: 'success',
    requestId: body.requestId,
    conversationId: body.conversationId,
    result,
    candidateId: typeof body.candidateId === 'string' ? body.candidateId : null,
    turn: typeof body.turn === 'number' ? body.turn : null,
    maxTurns: typeof body.maxTurns === 'number' ? body.maxTurns : null,
  }
}

export interface CancelConversationParams {
  baseUrl: string
  sessionToken: string
  installId: string
  conversationId: string
  timeoutMs?: number
}

const DEFAULT_CANCEL_TIMEOUT_MS = 10_000

/**
 * 会話のbest-effortキャンセル。失敗してもUI上は常にホームへ戻ってよい
 * (会話はTTLで自然に失効するため、通知の到達を保証する必要はない)。
 */
export async function cancelConversation(params: CancelConversationParams): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS)
  try {
    await fetch(`${params.baseUrl}/plugin/conversations/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.sessionToken}`,
        'X-Install-Id': params.installId,
      },
      body: JSON.stringify({ conversationId: params.conversationId }),
      signal: controller.signal,
    })
  } catch {
    // best-effort: 失敗してもホーム遷移は継続する
  } finally {
    clearTimeout(timer)
  }
}
