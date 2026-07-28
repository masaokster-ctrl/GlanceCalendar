import type { ProductTokenStore } from './tokenStore'

const DEFAULT_TIMEOUT_MS = 15_000

export interface RefreshSessionParams {
  baseUrl: string
  installationId: string
  refreshToken: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type RefreshSessionOutcome =
  | {
      kind: 'success'
      accessToken: string
      accessTokenExpiresInSeconds: number
      refreshToken: string
      refreshTokenExpiresAt: string
      scopes: string[]
    }
  | { kind: 'failed' }

/** POST /product/sessions/refresh。失敗理由(401/429/network等)を呼び出し側へ区別して返す必要はなく、
 * 「rotateできたか否か」だけが呼び出し側(ProductAuthManager)の判断材料になる。 */
export async function refreshProductSession(params: RefreshSessionParams): Promise<RefreshSessionOutcome> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchController = new AbortController()
  const timeoutTimer = setTimeout(() => fetchController.abort(), timeoutMs)
  const onExternalAbort = (): void => fetchController.abort()
  params.signal?.addEventListener('abort', onExternalAbort)
  const cleanup = (): void => {
    clearTimeout(timeoutTimer)
    params.signal?.removeEventListener('abort', onExternalAbort)
  }

  let response: Response
  try {
    response = await fetch(`${params.baseUrl}/product/sessions/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Installation-Id': params.installationId },
      body: JSON.stringify({ refreshToken: params.refreshToken }),
      signal: fetchController.signal,
    })
  } catch {
    cleanup()
    return { kind: 'failed' }
  }
  cleanup()

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

export interface ProductAuthManagerDeps {
  tokenStore: ProductTokenStore
  baseUrl: string
  installationId: string
  refreshFn?: (params: RefreshSessionParams) => Promise<RefreshSessionOutcome>
  now?: () => Date
  /**
   * refresh失敗時に呼ばれる。呼び出し側(app.ts)が未接続画面への遷移・進行中状態のリセットを
   * 完了するまで getAccessToken()/handleAuthFailure() 自体を待たせるため、Promiseを返す実装は
   * 必ずここでawaitされる。
   */
  onDisconnected?: () => void | Promise<void>
}

/**
 * 製品モードのAPIクライアント全体で共有する認可プロバイダ(フェーズ2H・セクション10、フェーズ2Iで
 * access tokenのメモリ限定保持へ変更)。
 * - access tokenはこのクラスのメモリ上でのみ保持し、TokenStore(bridge storage)には一切保存しない。
 * - TokenStoreに永続化するのはrotating refresh tokenのみ。アプリ再起動直後は必ずrefreshを1回行う。
 * - 同時に複数呼び出しが発生しても、実際のrefreshネットワーク呼び出しは1回だけ実行する(single-flight)。
 * - refresh成功後、呼び出し元は元のリクエストを最大1回だけ再試行してよい(このクラス自身は再試行しない)。
 * - refresh失敗時はTokenStoreをclearし、onDisconnectedを呼ぶ(呼び出し側が未接続画面へ遷移する)。
 */
export class ProductAuthManager {
  private readonly tokenStore: ProductTokenStore
  private readonly baseUrl: string
  private readonly installationId: string
  private readonly refreshFn: (params: RefreshSessionParams) => Promise<RefreshSessionOutcome>
  private readonly now: () => Date
  private readonly onDisconnected: (() => void | Promise<void>) | undefined
  private inFlightRefresh: Promise<boolean> | null = null
  private accessToken: { token: string; expiresAt: number } | null = null

  constructor(deps: ProductAuthManagerDeps) {
    this.tokenStore = deps.tokenStore
    this.baseUrl = deps.baseUrl
    this.installationId = deps.installationId
    this.refreshFn = deps.refreshFn ?? refreshProductSession
    this.now = deps.now ?? (() => new Date())
    this.onDisconnected = deps.onDisconnected
  }

  /** ペアリングexchange直後、サーバーが返した新規access tokenをメモリへ直接反映する(refresh不要)。 */
  primeAccessToken(token: string, expiresInSeconds: number): void {
    this.accessToken = { token, expiresAt: this.now().getTime() + expiresInSeconds * 1000 }
  }

  /** 現在有効なaccess tokenを返す。メモリに無い/期限切れならrefresh tokenで取得し直す。接続情報が無ければnull。 */
  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && this.accessToken.expiresAt > this.now().getTime()) {
      return this.accessToken.token
    }
    const ok = await this.triggerRefresh()
    return ok && this.accessToken ? this.accessToken.token : null
  }

  /**
   * 401到達後に呼ぶ。true を返した場合のみ、呼び出し側は同一リクエストを1回だけ再試行してよい。
   * 複数の呼び出し元が同時にこれを呼んでも、実際のネットワークrefreshは高々1回しか走らない。
   */
  async handleAuthFailure(): Promise<boolean> {
    this.accessToken = null // 拒否された(既にキャッシュされていた)access tokenを破棄してから再取得する
    return this.triggerRefresh()
  }

  private async triggerRefresh(): Promise<boolean> {
    if (this.inFlightRefresh) {
      return this.inFlightRefresh
    }
    const promise = this.doRefresh()
    this.inFlightRefresh = promise
    try {
      return await promise
    } finally {
      this.inFlightRefresh = null
    }
  }

  private async doRefresh(): Promise<boolean> {
    const credential = await this.tokenStore.load()
    if (!credential) {
      await this.onDisconnected?.()
      return false
    }

    const outcome = await this.refreshFn({
      baseUrl: this.baseUrl,
      installationId: this.installationId,
      refreshToken: credential.refreshToken,
    })

    if (outcome.kind !== 'success') {
      await this.tokenStore.clear()
      this.accessToken = null
      await this.onDisconnected?.()
      return false
    }

    this.accessToken = { token: outcome.accessToken, expiresAt: this.now().getTime() + outcome.accessTokenExpiresInSeconds * 1000 }
    await this.tokenStore.save({ refreshToken: outcome.refreshToken, refreshTokenExpiresAt: outcome.refreshTokenExpiresAt })
    return true
  }
}
