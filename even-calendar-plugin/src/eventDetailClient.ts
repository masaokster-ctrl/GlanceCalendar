import { parseEventDetail, type EventDetail } from './eventDetail'
import type { Locale } from './i18n/locale'

const DEFAULT_TIMEOUT_MS = 15_000

// --- GET /plugin/calendar-events/:eventId ---

export type FetchEventDetailOutcome =
  | { kind: 'success'; result: EventDetail }
  | { kind: 'aborted' }
  | { kind: 'auth_failed' }
  | { kind: 'forbidden' }
  | { kind: 'not_found' }
  | { kind: 'rate_limited' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'failed' }

export interface FetchEventDetailParams {
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

function withInternalTimeout(
  signal: AbortSignal,
  timeoutMs: number,
): { fetchController: AbortController; cleanup: () => void } {
  const fetchController = new AbortController()
  const timeoutTimer = setTimeout(() => fetchController.abort(), timeoutMs)
  const onExternalAbort = (): void => fetchController.abort()
  signal.addEventListener('abort', onExternalAbort)
  return {
    fetchController,
    cleanup: () => {
      clearTimeout(timeoutTimer)
      signal.removeEventListener('abort', onExternalAbort)
    },
  }
}

/**
 * 認証付きでGET /plugin/calendar-events/:eventIdを1回だけ呼ぶ。自動リトライは行わない
 * (呼び出し側もリトライしないこと)。signal(キャンセル用)とタイムアウトの両方を尊重する。
 */
export async function fetchEventDetail(params: FetchEventDetailParams): Promise<FetchEventDetailOutcome> {
  if (params.signal.aborted) {
    return { kind: 'aborted' }
  }

  const { fetchController, cleanup } = withInternalTimeout(params.signal, params.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let response: Response
  try {
    const localeQuery = params.locale ? `?locale=${params.locale}` : ''
    response = await fetch(`${params.baseUrl}/plugin/calendar-events/${encodeURIComponent(params.eventId)}${localeQuery}`, {
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
    if (params.signal.aborted) return { kind: 'aborted' }
    if (fetchController.signal.aborted) return { kind: 'timeout' }
    return { kind: 'network_error' }
  }
  cleanup()

  if (params.signal.aborted) return { kind: 'aborted' }

  if (response.status === 401 || response.status === 403) return { kind: 'auth_failed' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status === 429) return { kind: 'rate_limited' }
  if (response.status === 504) return { kind: 'timeout' }
  if (!response.ok) return { kind: 'failed' }

  const data: unknown = await response.json().catch(() => null)
  if (typeof data !== 'object' || data === null) return { kind: 'failed' }
  const body = data as { schemaVersion?: unknown; event?: unknown }
  if (body.schemaVersion !== '1') return { kind: 'failed' }

  const result = parseEventDetail(body.event)
  if (!result) return { kind: 'failed' }

  return { kind: 'success', result }
}

// --- PATCH /plugin/calendar-events/:eventId ---

export interface UpdateEventFields {
  title?: string
  location?: string
  description?: string
  startLocal?: string
  endLocal?: string
  allDay?: boolean
  startDate?: string
  endDateExclusive?: string
}

export type UpdateEventOutcome =
  | { kind: 'success'; eventId: string }
  | { kind: 'aborted' }
  | { kind: 'auth_failed' }
  | { kind: 'invalid' }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'rate_limited' }
  | { kind: 'not_connected' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'failed' }

export interface UpdateEventParams {
  eventId: string
  idempotencyKey: string
  fields: UpdateEventFields
  baseUrl: string
  sessionToken: string
  installId: string
  requestId: string
  signal: AbortSignal
  timeoutMs?: number
}

/**
 * PATCH /plugin/calendar-events/:eventId を1回だけ呼ぶ。自動リトライは行わない
 * (同じ操作の再試行時は呼び出し側が同一idempotencyKeyを渡すことでサーバー側の重複適用を防ぐ)。
 */
export async function updateCalendarEventDetail(params: UpdateEventParams): Promise<UpdateEventOutcome> {
  if (params.signal.aborted) {
    return { kind: 'aborted' }
  }

  const { fetchController, cleanup } = withInternalTimeout(params.signal, params.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${params.baseUrl}/plugin/calendar-events/${encodeURIComponent(params.eventId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.sessionToken}`,
        'X-Install-Id': params.installId,
        'X-Request-Id': params.requestId,
      },
      body: JSON.stringify({ idempotencyKey: params.idempotencyKey, ...params.fields }),
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

  if (response.status === 400) return { kind: 'invalid' }
  if (response.status === 401 || response.status === 403) return { kind: 'auth_failed' }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status === 409) return { kind: 'conflict' }
  if (response.status === 429) return { kind: 'rate_limited' }
  if (response.status === 503) return { kind: 'not_connected' }
  if (response.status === 504) return { kind: 'timeout' }
  if (!response.ok) return { kind: 'failed' }

  const data: unknown = await response.json().catch(() => null)
  const eventId = (data as { eventId?: unknown } | null)?.eventId
  if (typeof eventId !== 'string') return { kind: 'failed' }

  return { kind: 'success', eventId }
}

// --- DELETE /plugin/calendar-events/:eventId?idempotencyKey=... ---

export type DeleteEventOutcome =
  | { kind: 'success'; eventId: string }
  | { kind: 'aborted' }
  | { kind: 'auth_failed' }
  | { kind: 'conflict' }
  | { kind: 'rate_limited' }
  | { kind: 'not_connected' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'failed' }

export interface DeleteEventParams {
  eventId: string
  idempotencyKey: string
  baseUrl: string
  sessionToken: string
  installId: string
  requestId: string
  signal: AbortSignal
  timeoutMs?: number
}

/** DELETE /plugin/calendar-events/:eventId を1回だけ呼ぶ。既に削除済みのイベントもサーバー側で200/deletedとして扱われる(冪等)。 */
export async function deleteCalendarEventDetail(params: DeleteEventParams): Promise<DeleteEventOutcome> {
  if (params.signal.aborted) {
    return { kind: 'aborted' }
  }

  const { fetchController, cleanup } = withInternalTimeout(params.signal, params.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(
      `${params.baseUrl}/plugin/calendar-events/${encodeURIComponent(params.eventId)}?idempotencyKey=${encodeURIComponent(params.idempotencyKey)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${params.sessionToken}`,
          'X-Install-Id': params.installId,
          'X-Request-Id': params.requestId,
        },
        signal: fetchController.signal,
      },
    )
  } catch {
    cleanup()
    if (params.signal.aborted) return { kind: 'aborted' }
    if (fetchController.signal.aborted) return { kind: 'timeout' }
    return { kind: 'network_error' }
  }
  cleanup()

  if (params.signal.aborted) return { kind: 'aborted' }

  if (response.status === 401 || response.status === 403) return { kind: 'auth_failed' }
  if (response.status === 409) return { kind: 'conflict' }
  if (response.status === 429) return { kind: 'rate_limited' }
  if (response.status === 503) return { kind: 'not_connected' }
  if (response.status === 504) return { kind: 'timeout' }
  if (!response.ok) return { kind: 'failed' }

  const data: unknown = await response.json().catch(() => null)
  const eventId = (data as { eventId?: unknown } | null)?.eventId
  if (typeof eventId !== 'string') return { kind: 'failed' }

  return { kind: 'success', eventId }
}
