import { parseEditInstructionResponse, type EditInstructionResult } from './editInstruction'
import type { Locale } from './i18n/locale'

export type AnalyzeEditAudioOutcome =
  | { kind: 'success'; result: EditInstructionResult }
  | { kind: 'aborted' }
  | { kind: 'auth_failed' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'rate_limited' }
  | { kind: 'failed' }

export interface AnalyzeEditAudioParams {
  wav: Uint8Array
  eventId: string
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

/** TS 5.7+ の Uint8Array<ArrayBufferLike> をfetchのBodyInit(素のArrayBuffer)に安全に渡すためのコピー。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/**
 * 音声編集指示(例:「開始時刻を15時に変更」)をバックエンドへ送信し、構造化フィールド差分を受け取る。
 *
 * NOTE(要フォローアップ): /plugin/analyze-edit-audio は本実装時点で実バックエンドに存在しない可能性が
 * 高い(この編集意図の解析にはGemini側の別スキーマ対応が要る)。存在しない間はこの呼び出しは
 * 404等でkind:'failed'相当になる想定であり、フォールバックの自前解析は行わない
 * (parseEditInstructionResponse()のとおりバックエンドが応答すれば、そのままこの関数が使える設計)。
 * WAVバイト列はこの関数呼び出しのスコープ内でのみ参照し、呼び出し後は速やかに解放すること。
 */
export async function analyzeEditAudio(params: AnalyzeEditAudioParams): Promise<AnalyzeEditAudioOutcome> {
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
    response = await fetch(`${params.baseUrl}/plugin/analyze-edit-audio${localeQuery}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        Authorization: `Bearer ${params.sessionToken}`,
        'X-Install-Id': params.installId,
        'X-Request-Id': params.requestId,
        'X-Event-Id': params.eventId,
      },
      body: toArrayBuffer(params.wav),
      signal: fetchController.signal,
    })
  } catch {
    cleanup()
    if (params.signal.aborted) return { kind: 'aborted' }
    if (fetchController.signal.aborted) return { kind: 'timeout' }
    return { kind: 'network_error' }
  }
  cleanup()

  if (params.signal.aborted) return { kind: 'aborted' }

  if (response.status === 401 || response.status === 403) return { kind: 'auth_failed' }
  if (response.status === 429) return { kind: 'rate_limited' }
  if (response.status === 504) return { kind: 'timeout' }
  if (!response.ok) return { kind: 'failed' }

  const data: unknown = await response.json().catch(() => null)
  if (typeof data !== 'object' || data === null) return { kind: 'failed' }
  const body = data as { requestId?: unknown; result?: unknown }
  if (typeof body.requestId !== 'string') return { kind: 'failed' }

  const result = parseEditInstructionResponse(body.result)
  if (!result) return { kind: 'failed' }

  return { kind: 'success', result }
}
