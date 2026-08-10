import { parseEventCandidateResult, type EventCandidateResult } from './eventCandidate'
import type { Locale } from './i18n/locale'

export type AnalyzeAudioOutcome =
  | {
      kind: 'success'
      requestId: string
      result: EventCandidateResult
      candidateId: string | null
      conversationId: string | null
      turn: number | null
      maxTurns: number | null
    }
  | { kind: 'aborted' }
  | { kind: 'auth_failed' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'rate_limited' }
  | { kind: 'failed' }

export interface AnalyzeAudioParams {
  wav: Uint8Array
  baseUrl: string
  sessionToken: string
  installId: string
  requestId: string
  signal: AbortSignal
  timeoutMs?: number
  /** 未指定時は従来と完全同一のURL(locale query無し)。正規化済みの'ja'|'en'のみを渡すこと。 */
  locale?: Locale
}

const DEFAULT_TIMEOUT_MS = 35_000

/**
 * TS 5.7+ の Uint8Array<ArrayBufferLike> は fetch の BodyInit(素のArrayBuffer限定)に
 * 直接代入できないため、新規ArrayBufferへ明示的にコピーしてから渡す。WAVは最大約1MBなので
 * コピーコストは無視できる。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/**
 * WAVを認証付きでバックエンドへ送信する。自動リトライは行わない(呼び出し側もリトライしないこと)。
 * signal(二度押しキャンセル用)とタイムアウトの両方を尊重する。WAVバイト列はこの関数呼び出しの
 * スコープ内でのみ参照し、呼び出し後は呼び出し側で速やかに解放すること。
 *
 * fetch自体のsignalは内部のfetchControllerに統一し、外部signal(キャンセル)発火時とタイムアウト発火時の
 * 両方でfetchControllerをabortする。実際に中断した原因は「外部signalが既にabortされていたか」で判別する
 * (外部signalがabortされていなければ、fetchControllerを中断させたのは内部のタイムアウトのみ)。
 */
export async function analyzeAudio(params: AnalyzeAudioParams): Promise<AnalyzeAudioOutcome> {
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
    const localeQuery = params.locale ? `?locale=${params.locale}` : ''
    response = await fetch(`${params.baseUrl}/plugin/analyze-audio${localeQuery}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        Authorization: `Bearer ${params.sessionToken}`,
        'X-Install-Id': params.installId,
        'X-Request-Id': params.requestId,
      },
      body: toArrayBuffer(params.wav),
      signal: fetchController.signal,
    })
  } catch {
    cleanup()
    if (params.signal.aborted) {
      return { kind: 'aborted' }
    }
    // fetchControllerが中断された原因が外部signalでなければ、内部タイムアウトタイマーによるものと判別できる。
    // それ以外(fetchControllerも中断されていない)は純粋なネットワーク層の失敗。
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
  if (response.status === 429) return { kind: 'rate_limited' }
  if (response.status === 504) return { kind: 'timeout' }
  if (!response.ok) return { kind: 'failed' }

  const data: unknown = await response.json().catch(() => null)
  if (typeof data !== 'object' || data === null) return { kind: 'failed' }

  const body = data as {
    requestId?: unknown
    result?: unknown
    candidateId?: unknown
    conversationId?: unknown
    turn?: unknown
    maxTurns?: unknown
  }
  if (typeof body.requestId !== 'string') return { kind: 'failed' }

  const result = parseEventCandidateResult(body.result)
  if (!result) return { kind: 'failed' }

  const candidateId = typeof body.candidateId === 'string' ? body.candidateId : null
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
  const turn = typeof body.turn === 'number' ? body.turn : null
  const maxTurns = typeof body.maxTurns === 'number' ? body.maxTurns : null

  return { kind: 'success', requestId: body.requestId, result, candidateId, conversationId, turn, maxTurns }
}
