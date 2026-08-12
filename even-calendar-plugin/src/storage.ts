// SDKの bridge.setLocalStorage/getLocalStorage を使う(ブラウザの window.localStorage は
// このFlutter WebView環境では再起動時に確実に永続化されないため使用しない)。
// 保存するのは安全な値(backendAvailableの真偽、locale)だけで、PCM・発話・Token・Secret・
// Calendar/OAuth情報は一切保存しない。
import type { Locale } from './i18n/locale'

export interface BridgeStorageLike {
  setLocalStorage(key: string, value: string): Promise<boolean>
  getLocalStorage(key: string): Promise<string>
}

const KEY_BACKEND_AVAILABLE = 'even-calendar.backendAvailable'
const KEY_LOCALE = 'even-calendar.locale'

export async function saveBackendAvailable(bridge: BridgeStorageLike, value: boolean): Promise<void> {
  await bridge.setLocalStorage(KEY_BACKEND_AVAILABLE, value ? '1' : '0')
}

export async function loadBackendAvailable(bridge: BridgeStorageLike): Promise<boolean | null> {
  const raw = await bridge.getLocalStorage(KEY_BACKEND_AVAILABLE)
  if (raw === '1') return true
  if (raw === '0') return false
  return null
}

/** Home menuの「Language」画面でユーザーが明示的に言語を選択した時にのみ呼ばれる(自動検出結果の書き戻しには使わない)。 */
export async function saveLocale(bridge: BridgeStorageLike, value: Locale): Promise<void> {
  await bridge.setLocalStorage(KEY_LOCALE, value)
}

/** 'ja'|'en'以外の値(未設定・不正値)はnullを返す。detectLocale()のstored引数にそのまま渡せる。 */
export async function loadLocale(bridge: BridgeStorageLike): Promise<Locale | null> {
  const raw = await bridge.getLocalStorage(KEY_LOCALE)
  if (raw === 'ja' || raw === 'en') return raw
  return null
}
