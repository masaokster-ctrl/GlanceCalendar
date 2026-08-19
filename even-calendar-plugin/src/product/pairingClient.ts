const DEFAULT_TIMEOUT_MS = 15_000

export interface StartPairingParams {
  baseUrl: string
  installationId: string
  appVersion?: string
  sdkVersion?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type StartPairingOutcome =
  | {
      kind: 'success'
      pairingId: string
      userCode: string
      verificationUrl: string
      expiresInSeconds: number
      pollIntervalSeconds: number
    }
  | { kind: 'aborted' }
  | { kind: 'rate_limited' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'failed' }

async function withTimeoutFetch(
  url: string,
  init: RequestInit,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ response: Response } | { error: 'aborted' | 'timeout' | 'network_error' }> {
  if (externalSignal?.aborted) {
    return { error: 'aborted' }
  }
  const fetchController = new AbortController()
  const timeoutTimer = setTimeout(() => fetchController.abort(), timeoutMs)
  const onExternalAbort = (): void => fetchController.abort()
  externalSignal?.addEventListener('abort', onExternalAbort)
  const cleanup = (): void => {
    clearTimeout(timeoutTimer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }

  try {
    const response = await fetch(url, { ...init, signal: fetchController.signal })
    cleanup()
    if (externalSignal?.aborted) return { error: 'aborted' }
    return { response }
  } catch {
    cleanup()
    if (externalSignal?.aborted) return { error: 'aborted' }
    if (fetchController.signal.aborted) return { error: 'timeout' }
    return { error: 'network_error' }
  }
}

/** ペアリング開始。認証不要・installationId/appVersion/sdkVersionのみを送る。 */
export async function startPairing(params: StartPairingParams): Promise<StartPairingOutcome> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const result = await withTimeoutFetch(
    `${params.baseUrl}/product/pairings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId: params.installationId,
        ...(params.appVersion !== undefined ? { appVersion: params.appVersion } : {}),
        ...(params.sdkVersion !== undefined ? { sdkVersion: params.sdkVersion } : {}),
      }),
    },
    params.signal,
    timeoutMs,
  )
  if ('error' in result) return { kind: result.error }

  const { response } = result
  if (response.status === 429) return { kind: 'rate_limited' }
  if (response.status === 504) return { kind: 'timeout' }
  if (!response.ok) return { kind: 'failed' }

  const data: unknown = await response.json().catch(() => null)
  if (typeof data !== 'object' || data === null) return { kind: 'failed' }
  const body = data as {
    pairingId?: unknown
    userCode?: unknown
    verificationUrl?: unknown
    expiresInSeconds?: unknown
    pollIntervalSeconds?: unknown
  }
  if (
    typeof body.pairingId !== 'string' ||
    typeof body.userCode !== 'string' ||
    typeof body.verificationUrl !== 'string' ||
    typeof body.expiresInSeconds !== 'number' ||
    typeof body.pollIntervalSeconds !== 'number'
  ) {
    return { kind: 'failed' }
  }

  return {
    kind: 'success',
    pairingId: body.pairingId,
    userCode: body.userCode,
    verificationUrl: body.verificationUrl,
    expiresInSeconds: body.expiresInSeconds,
    pollIntervalSeconds: body.pollIntervalSeconds,
  }
}

export type PairingStatus = 'pending' | 'oauth_in_progress' | 'approved' | 'exchanged' | 'expired' | 'cancelled' | 'failed'

export interface CheckPairingStatusParams {
  baseUrl: string
  pairingId: string
  installationId: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type CheckPairingStatusOutcome =
  | { kind: 'success'; status: PairingStatus }
  | { kind: 'aborted' }
  | { kind: 'rate_limited' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'failed' }

const KNOWN_STATUSES: readonly PairingStatus[] = ['pending', 'oauth_in_progress', 'approved', 'exchanged', 'expired', 'cancelled', 'failed']

export async function checkPairingStatus(params: CheckPairingStatusParams): Promise<CheckPairingStatusOutcome> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const result = await withTimeoutFetch(
    `${params.baseUrl}/product/pairings/${params.pairingId}/status`,
    { method: 'GET', headers: { 'X-Installation-Id': params.installationId } },
    params.signal,
    timeoutMs,
  )
  if ('error' in result) return { kind: result.error }

  const { response } = result
  if (response.status === 429) return { kind: 'rate_limited' }
  if (response.status === 504) return { kind: 'timeout' }
  if (!response.ok) return { kind: 'failed' }

  const data: unknown = await response.json().catch(() => null)
  if (typeof data !== 'object' || data === null) return { kind: 'failed' }
  const status = (data as { status?: unknown }).status
  if (typeof status !== 'string' || !KNOWN_STATUSES.includes(status as PairingStatus)) return { kind: 'failed' }

  return { kind: 'success', status: status as PairingStatus }
}

export interface CancelPairingParams {
  baseUrl: string
  pairingId: string
  installationId: string
  timeoutMs?: number
}

/** best-effort/idempotentなので、失敗しても呼び出し側の画面遷移はブロックしない。 */
export async function cancelPairing(params: CancelPairingParams): Promise<void> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  await withTimeoutFetch(
    `${params.baseUrl}/product/pairings/${params.pairingId}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: params.installationId }),
    },
    undefined,
    timeoutMs,
  )
}

export interface ExchangePairingParams {
  baseUrl: string
  pairingId: string
  installationId: string
  /** Plugin側でCSPRNG生成済みのcredential候補(生値・64桁hex)。Backendはこれをhash化して登録するだけで、
   *  自分では生成しない(client-generated credential方式)。 */
  accessToken: string
  refreshToken: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type ExchangePairingOutcome =
  | {
      kind: 'success'
      accessToken: string
      accessTokenExpiresInSeconds: number
      refreshToken: string
      refreshTokenExpiresAt: string
      scopes: string[]
    }
  | { kind: 'aborted' }
  | { kind: 'not_ready' }
  | { kind: 'timeout' }
  | { kind: 'network_error' }
  | { kind: 'failed' }

export async function exchangePairing(params: ExchangePairingParams): Promise<ExchangePairingOutcome> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const result = await withTimeoutFetch(
    `${params.baseUrl}/product/pairings/${params.pairingId}/exchange`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: params.installationId, accessToken: params.accessToken, refreshToken: params.refreshToken }),
    },
    params.signal,
    timeoutMs,
  )
  if ('error' in result) return { kind: result.error }

  const { response } = result
  if (response.status === 400 || response.status === 409) return { kind: 'not_ready' }
  if (response.status === 504) return { kind: 'timeout' }
  if (!response.ok) return { kind: 'failed' }

  const data: unknown = await response.json().catch(() => null)
  if (typeof data !== 'object' || data === null) return { kind: 'failed' }
  const body = data as {
    accessToken?: unknown
    accessTokenExpiresInSeconds?: unknown
    refreshToken?: unknown
    refreshTokenExpiresAt?: unknown
    scopes?: unknown
  }
  if (
    typeof body.accessToken !== 'string' ||
    typeof body.accessTokenExpiresInSeconds !== 'number' ||
    typeof body.refreshToken !== 'string' ||
    typeof body.refreshTokenExpiresAt !== 'string' ||
    !Array.isArray(body.scopes)
  ) {
    return { kind: 'failed' }
  }

  return {
    kind: 'success',
    accessToken: body.accessToken,
    accessTokenExpiresInSeconds: body.accessTokenExpiresInSeconds,
    refreshToken: body.refreshToken,
    refreshTokenExpiresAt: body.refreshTokenExpiresAt,
    scopes: body.scopes.filter((s): s is string => typeof s === 'string'),
  }
}
