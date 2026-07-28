import type { BridgeStorageLike } from './tokenStore'

const STORAGE_KEY = 'even-calendar.installationId'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * crypto.randomUUID()はSecure Context限定のため(app.tsのgenerateRequestIdと同じ理由により)、
 * crypto.getRandomValues()ベースで自前生成する。
 */
function generateInstallationId(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 初回起動時にinstallationIdを生成しbridge storageへ永続化する。以後は同じ値を再利用する。 */
export async function getOrCreateInstallationId(bridge: BridgeStorageLike): Promise<string> {
  const existing = await bridge.getLocalStorage(STORAGE_KEY)
  if (existing && UUID_PATTERN.test(existing)) {
    return existing
  }
  const generated = generateInstallationId()
  await bridge.setLocalStorage(STORAGE_KEY, generated)
  return generated
}
