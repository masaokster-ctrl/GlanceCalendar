const DEFAULT_TIMEOUT_MS = 35_000

export type RegisterEventOutcome =
  | { kind: 'success' }
  | { kind: 'aborted' }
  | { kind: 'auth_failed' }
  | { kind: 'candidate_expired' }
  | { kind: 'oauth_not_connected' }
  | { kind: 'network_error' }
  | { kind: 'timeout' }
  | { kind: 'failed' }

interface RegisterEventParamsBase {
  baseUrl: string
  sessionToken: string
  installId: string
  requestId: string
  candidateId: string
  title: string
  timeZone: string
  signal: AbortSignal
  timeoutMs?: number
}

/**
 * POST /plugin/calendar-eventsのボディ形状(isValidBodyShape)と1対1で対応する判別共用体。
 * allDay===falseはstartLocal/endLocalのみ、allDay===trueはstartDate/endDateExclusiveのみを持ち、
 * 混在は型レベルで作れない(サーバー側の「フィールド混在を拒否する」検証に合わせている)。
 */
export type RegisterEventParams =
  | (RegisterEventParamsBase & { allDay: false; startLocal: string; endLocal: string })
  | (RegisterEventParamsBase & { allDay: true; startDate: string; endDateExclusive: string })

/**
 * 候補IDをもとにCalendarへの登録をPOSTする。自動リトライは行わない。
 * signal(二度押しキャンセル用)とタイムアウトの両方を尊重する。
 */
export async function registerCalendarEvent(params: RegisterEventParams): Promise<RegisterEventOutcome> {
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
    response = await fetch(`${params.baseUrl}/plugin/calendar-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.sessionToken}`,
        'X-Install-Id': params.installId,
        'X-Request-Id': params.requestId,
      },
      body: JSON.stringify(
        params.allDay
          ? {
              schemaVersion: '1',
              candidateId: params.candidateId,
              title: params.title,
              timeZone: params.timeZone,
              allDay: true,
              startDate: params.startDate,
              endDateExclusive: params.endDateExclusive,
            }
          : {
              schemaVersion: '1',
              candidateId: params.candidateId,
              title: params.title,
              timeZone: params.timeZone,
              allDay: false,
              startLocal: params.startLocal,
              endLocal: params.endLocal,
            },
      ),
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
  if (response.status === 410) return { kind: 'candidate_expired' }
  if (response.status === 503) return { kind: 'oauth_not_connected' }
  if (response.status === 200) return { kind: 'success' }
  return { kind: 'failed' }
}

export type CalendarEventStatus = 'pending' | 'creating' | 'completed' | 'failed' | 'expired'

export type CheckStatusOutcome = { kind: 'status'; status: CalendarEventStatus } | { kind: 'auth_failed' } | { kind: 'network_error' }

export interface CheckStatusParams {
  baseUrl: string
  sessionToken: string
  installId: string
  candidateId: string
  timeoutMs?: number
}

const DEFAULT_STATUS_TIMEOUT_MS = 10_000

/** 登録結果の確認用。読み取り専用でCalendarへの副作用はない(何度呼んでも安全)。 */
export async function checkCalendarEventStatus(params: CheckStatusParams): Promise<CheckStatusOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${params.baseUrl}/plugin/calendar-events/status?candidateId=${encodeURIComponent(params.candidateId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.sessionToken}`,
        'X-Install-Id': params.installId,
      },
      signal: controller.signal,
    })
  } catch {
    clearTimeout(timer)
    return { kind: 'network_error' }
  }
  clearTimeout(timer)

  if (response.status === 401 || response.status === 403) return { kind: 'auth_failed' }
  if (!response.ok) return { kind: 'network_error' }

  const data: unknown = await response.json().catch(() => null)
  const status = (data as { status?: unknown } | null)?.status
  const validStatuses: CalendarEventStatus[] = ['pending', 'creating', 'completed', 'failed', 'expired']
  if (typeof status !== 'string' || !validStatuses.includes(status as CalendarEventStatus)) {
    return { kind: 'network_error' }
  }

  return { kind: 'status', status: status as CalendarEventStatus }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface PollForCompletionParams extends CheckStatusParams {
  maxAttempts?: number
  intervalMs?: number
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_POLL_INTERVAL_MS = 2000

/** 最大maxAttempts回、intervalMsごとにstatusを確認する。completedになった時点で即座に返す。 */
export async function pollForCompletion(params: PollForCompletionParams): Promise<CheckStatusOutcome> {
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const intervalMs = params.intervalMs ?? DEFAULT_POLL_INTERVAL_MS

  let lastOutcome: CheckStatusOutcome = { kind: 'network_error' }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await delay(intervalMs)
    lastOutcome = await checkCalendarEventStatus(params)
    if (lastOutcome.kind === 'status' && lastOutcome.status === 'completed') {
      return lastOutcome
    }
    if (lastOutcome.kind === 'auth_failed') {
      return lastOutcome
    }
  }
  return lastOutcome
}
