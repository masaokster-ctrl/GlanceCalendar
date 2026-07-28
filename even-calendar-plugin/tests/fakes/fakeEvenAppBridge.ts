import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { BridgeLike } from '../../src/app'

export interface TextUpgradeCall {
  containerID?: number
  containerName?: string
  content?: string
  contentOffset?: number
  contentLength?: number
}

export interface AudioControlCall {
  isOpen: boolean
  source?: unknown
}

/** テスト専用のFake実装。実SDK・実G2・実ネットワークへは一切アクセスしない。 */
export class FakeEvenAppBridge implements BridgeLike {
  public createStartUpCalls: unknown[] = []
  public textUpgradeCalls: TextUpgradeCall[] = []
  public audioControlCalls: AudioControlCall[] = []
  public shutDownCalls: number[] = []
  public storage = new Map<string, string>()

  public createStartUpResult = 0
  public audioControlResult = true
  public textUpgradeResult = true
  public shutDownResult = true

  // isOpen=false(停止)呼び出し専用の戻り値/例外制御。実機では戻り値が厳密なtrueでない場合があるため、
  // undefinedやfalseでも例外さえ投げなければ成功として扱われることをテストできるようにする。
  public audioControlStopResult: boolean | undefined = true
  public audioControlStopThrows = false

  // 停止後の画面更新(bridge呼び出し自体)の失敗を再現するためのフラグ。
  public textUpgradeThrows = false

  private listeners: Array<(event: EvenHubEvent) => void> = []

  async createStartUpPageContainer(params: unknown): Promise<number> {
    this.createStartUpCalls.push(params)
    return this.createStartUpResult
  }

  async textContainerUpgrade(params: TextUpgradeCall): Promise<boolean> {
    this.textUpgradeCalls.push(params)
    if (this.textUpgradeThrows) {
      throw new Error('textContainerUpgrade failed')
    }
    return this.textUpgradeResult
  }

  async audioControl(isOpen: boolean, source?: unknown): Promise<boolean> {
    this.audioControlCalls.push({ isOpen, source })
    if (!isOpen) {
      if (this.audioControlStopThrows) {
        throw new Error('audioControl(false) failed')
      }
      return this.audioControlStopResult as boolean
    }
    return this.audioControlResult
  }

  async shutDownPageContainer(exitMode?: number): Promise<boolean> {
    this.shutDownCalls.push(exitMode ?? -1)
    return this.shutDownResult
  }

  onEvenHubEvent(cb: (event: EvenHubEvent) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((listener) => listener !== cb)
    }
  }

  async setLocalStorage(key: string, value: string): Promise<boolean> {
    this.storage.set(key, value)
    return true
  }

  async getLocalStorage(key: string): Promise<string> {
    return this.storage.get(key) ?? ''
  }

  get listenerCount(): number {
    return this.listeners.length
  }

  /** テストからイベントを注入するためのヘルパー。 */
  emit(event: EvenHubEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  lastTextContent(): string | undefined {
    return this.textUpgradeCalls[this.textUpgradeCalls.length - 1]?.content
  }
}
