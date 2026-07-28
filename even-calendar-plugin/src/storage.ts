// SDKの bridge.setLocalStorage/getLocalStorage を使う(ブラウザの window.localStorage は
// このFlutter WebView環境では再起動時に確実に永続化されないため使用しない)。
// 保存するのは安全な値(backendAvailableの真偽)だけで、PCM・発話・Token・Secret・
// Calendar/OAuth情報は一切保存しない。

export interface BridgeStorageLike {
  setLocalStorage(key: string, value: string): Promise<boolean>
  getLocalStorage(key: string): Promise<string>
}

const KEY_BACKEND_AVAILABLE = 'even-calendar.backendAvailable'

export async function saveBackendAvailable(bridge: BridgeStorageLike, value: boolean): Promise<void> {
  await bridge.setLocalStorage(KEY_BACKEND_AVAILABLE, value ? '1' : '0')
}

export async function loadBackendAvailable(bridge: BridgeStorageLike): Promise<boolean | null> {
  const raw = await bridge.getLocalStorage(KEY_BACKEND_AVAILABLE)
  if (raw === '1') return true
  if (raw === '0') return false
  return null
}
