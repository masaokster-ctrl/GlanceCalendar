// 製品モード(Phase 2H/2I)のdevice session資格情報を保持するTokenStore。
// Even Hub SDKには bridge.setLocalStorage/getLocalStorage (平文文字列KV) 以外の永続化APIが
// 存在しない(OSレベルの安全な保管領域は未提供)ため、これがこのSDKで選べる唯一の永続化手段である。
// これは製品化に向けた既知のギャップとして完了報告で開示すること(将来的にSDKが安全な保管APIを
// 提供した場合は、ProductTokenStoreインターフェースはそのままにアダプタだけを差し替えられる設計)。
//
// フェーズ2I: access tokenはこのTokenStoreには一切保存しない(ProductAuthManagerがメモリ上でのみ
// 保持する)。永続化するのはrotating refresh tokenのみで、アプリ再起動後は必ずrefresh経由で
// 新しいaccess tokenを取得し直す。installationIdもここには含めない(別途installationId.tsで
// 独立して永続化される、静的に既知の値のため)。
//
// 【例外(pairing exchange再開のための限定的な方針変更)】exchange完了(このTokenStoreへのsave成功)
// より前の、pairing進行中(approved検知〜exchange確定まで)のaccess/refresh token候補に限っては、
// 別モジュール(pairingResumeStore.ts)がbridge.setLocalStorage経由で一時的に永続化する。これは
// 「確定済みaccess tokenはメモリのみ」という上記方針そのものを変更するものではなく、JS再起動を
// またいでpairing exchangeを安全に再開するためだけの、pairing処理中に限定した別レイヤーの一時保存
// である。pairingResumeStore側は、tokenStore.save()成功・cancel・expired・failedのいずれかで
// 必ず削除される(詳細はpairingResumeStore.tsを参照)。

export interface PersistedProductCredential {
  refreshToken: string
  refreshTokenExpiresAt: string // ISO 8601
}

export interface ProductTokenStore {
  load(): Promise<PersistedProductCredential | null>
  save(credential: PersistedProductCredential): Promise<void>
  clear(): Promise<void>
}

export interface BridgeStorageLike {
  setLocalStorage(key: string, value: string): Promise<boolean>
  getLocalStorage(key: string): Promise<string>
}

const STORAGE_KEY = 'even-calendar.productRefreshCredential'

function isPersistedProductCredential(value: unknown): value is PersistedProductCredential {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.refreshToken === 'string' && typeof v.refreshTokenExpiresAt === 'string'
}

/** bridge.setLocalStorage/getLocalStorageのみを使うTokenStore実装。唯一利用可能な永続化手段のため代替はない。 */
export class BridgeProductTokenStore implements ProductTokenStore {
  constructor(private readonly bridge: BridgeStorageLike) {}

  async load(): Promise<PersistedProductCredential | null> {
    const raw = await this.bridge.getLocalStorage(STORAGE_KEY)
    if (!raw) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    return isPersistedProductCredential(parsed) ? parsed : null
  }

  async save(credential: PersistedProductCredential): Promise<void> {
    await this.bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(credential))
  }

  async clear(): Promise<void> {
    await this.bridge.setLocalStorage(STORAGE_KEY, '')
  }
}
