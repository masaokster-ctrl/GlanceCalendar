// pairing進行中(startPairingFlow〜exchange確定)の最小限の状態をbridge storageへ永続化する。
// 目的: PluginのJS実行コンテキストが(/connect等スマートフォン内ブラウザへの遷移に伴って)破棄・
// 再起動されても、BOOT時にこの内容からpairingを安全に再開できるようにするため。
//
// window.localStorage(素のブラウザAPI)ではなくbridge.setLocalStorage/getLocalStorageを使う。
// tokenStore.ts/installationId.ts/storage.tsと同じ理由(このFlutter WebView環境ではwindow側の
// localStorageは再起動時に確実な永続化が保証されない)による。
//
// 保存する値の機微度: userCode(短命・単発・既にG2へ平文表示済み)、exchange候補のaccess/refresh
// token(exchange完了後は最終的にProductTokenStore/ProductAuthManagerが正式に保持するのと同じ値)。
// setTimeoutそのものを復元するのではなく、この最小限の識別情報からpollingやexchangeを再構築する
// (詳細はapp.tsのresumeロジックを参照)。

export interface PersistedExchangeCandidate {
  accessToken: string
  refreshToken: string
}

export interface PersistedPairingResume {
  pairingId: string
  userCode: string
  pollIntervalSeconds: number
  expiresAt: number // epoch ms(絶対時刻)
  exchangeCandidate: PersistedExchangeCandidate | null
}

export interface PairingResumeStore {
  load(): Promise<PersistedPairingResume | null>
  save(resume: PersistedPairingResume): Promise<void>
  clear(): Promise<void>
}

export interface BridgeStorageLike {
  setLocalStorage(key: string, value: string): Promise<boolean>
  getLocalStorage(key: string): Promise<string>
}

const STORAGE_KEY = 'even-calendar.pairingResume'

function isPersistedExchangeCandidate(value: unknown): value is PersistedExchangeCandidate {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.accessToken === 'string' && typeof v.refreshToken === 'string'
}

function isPersistedPairingResume(value: unknown): value is PersistedPairingResume {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.pairingId === 'string' &&
    typeof v.userCode === 'string' &&
    typeof v.pollIntervalSeconds === 'number' &&
    typeof v.expiresAt === 'number' &&
    (v.exchangeCandidate === null || isPersistedExchangeCandidate(v.exchangeCandidate))
  )
}

/** bridge.setLocalStorage/getLocalStorageのみを使う実装。唯一利用可能な永続化手段のため代替はない。 */
export class BridgePairingResumeStore implements PairingResumeStore {
  constructor(private readonly bridge: BridgeStorageLike) {}

  async load(): Promise<PersistedPairingResume | null> {
    const raw = await this.bridge.getLocalStorage(STORAGE_KEY)
    if (!raw) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    return isPersistedPairingResume(parsed) ? parsed : null
  }

  async save(resume: PersistedPairingResume): Promise<void> {
    await this.bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(resume))
  }

  async clear(): Promise<void> {
    await this.bridge.setLocalStorage(STORAGE_KEY, '')
  }
}
