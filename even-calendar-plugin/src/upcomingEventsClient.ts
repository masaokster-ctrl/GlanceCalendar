import { parseUpcomingEventsResult, type UpcomingEventsResult } from './upcomingEvents'
import type { Locale } from './i18n/locale'

export type FetchUpcomingEventsOutcome =
  | { kind: 'success'; result: UpcomingEventsResult }
  | { kind: 'aborted' }
  | { kind: 'auth_failed' }
  | { kind: 'forbidden' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'rate_limited' }
  | { kind: 'failed' }

export interface FetchUpcomingEventsParams {
  limit: number
  baseUrl: string
  sessionToken: string
  installId: string
  requestId: string
  signal: AbortSignal
  timeoutMs?: number
  /** 未指定時は従来と完全同一のURL(locale query無し)。正規化済みの'ja'|'en'のみを渡すこと。 */
  locale?: Locale
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 認証付きでGET /plugin/calendar-events/upcomingを1回だけ呼ぶ。自動リトライは行わない
 * (呼び出し側もリトライしないこと)。signal(二度押しキャンセル用)とタイムアウトの両方を尊重する。
 */
export async function fetchUpcomingEvents(params: FetchUpcomingEventsParams): Promise<FetchUpcomingEventsOutcome> {
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
    const localeQuery = params.locale ? `&locale=${params.locale}` : ''
    response = await fetch(`${params.baseUrl}/plugin/calendar-events/upcoming?limit=${params.limit}${localeQuery}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.sessionToken}`,
        'X-Install-Id': params.installId,
        'X-Request-Id': params.requestId,
      },
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

  if (response.status === 401) return { kind: 'auth_failed' }
  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 429) return { kind: 'rate_limited' }
  if (response.status === 504) return { kind: 'timeout' }
  if (!response.ok) return { kind: 'failed' }

  const data: unknown = await response.json().catch(() => null)
  const result = parseUpcomingEventsResult(data)
  if (!result) return { kind: 'failed' }

  return { kind: 'success', result }
}
