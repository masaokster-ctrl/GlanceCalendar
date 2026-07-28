import { describe, expect, it } from 'vitest'
import { BridgeProductTokenStore, type PersistedProductCredential } from '../../src/product/tokenStore'

class FakeStorage {
  private map = new Map<string, string>()
  async setLocalStorage(key: string, value: string): Promise<boolean> {
    this.map.set(key, value)
    return true
  }
  async getLocalStorage(key: string): Promise<string> {
    return this.map.get(key) ?? ''
  }
}

const CREDENTIAL: PersistedProductCredential = {
  refreshToken: 'refresh-token-1',
  refreshTokenExpiresAt: '2026-08-22T05:00:00.000Z',
}

describe('BridgeProductTokenStore', () => {
  it('returns null when nothing has been saved', async () => {
    const store = new BridgeProductTokenStore(new FakeStorage())
    expect(await store.load()).toBeNull()
  })

  it('round-trips a saved credential', async () => {
    const store = new BridgeProductTokenStore(new FakeStorage())
    await store.save(CREDENTIAL)
    expect(await store.load()).toEqual(CREDENTIAL)
  })

  it('clear() removes the stored credential', async () => {
    const store = new BridgeProductTokenStore(new FakeStorage())
    await store.save(CREDENTIAL)
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  it('never stores an access token field (memory-only per Phase 2I)', async () => {
    const store = new BridgeProductTokenStore(new FakeStorage())
    await store.save(CREDENTIAL)
    const loaded = await store.load()
    expect(loaded).not.toHaveProperty('accessToken')
    expect(Object.keys(loaded ?? {}).sort()).toEqual(['refreshToken', 'refreshTokenExpiresAt'])
  })

  it('returns null for corrupted/non-JSON stored data rather than throwing', async () => {
    const storage = new FakeStorage()
    await storage.setLocalStorage('even-calendar.productRefreshCredential', 'not-json{{{')
    const store = new BridgeProductTokenStore(storage)
    expect(await store.load()).toBeNull()
  })

  it('returns null for JSON that does not match the expected credential shape', async () => {
    const storage = new FakeStorage()
    await storage.setLocalStorage('even-calendar.productRefreshCredential', JSON.stringify({ foo: 'bar' }))
    const store = new BridgeProductTokenStore(storage)
    expect(await store.load()).toBeNull()
  })

  it('never uses a key other than the dedicated product-credential key (no leakage into other storage slots)', async () => {
    const storage = new FakeStorage()
    const store = new BridgeProductTokenStore(storage)
    await store.save(CREDENTIAL)
    const rawViaOtherKey = await storage.getLocalStorage('even-calendar.backendAvailable')
    expect(rawViaOtherKey).toBe('')
  })
})
