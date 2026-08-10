import { describe, expect, it } from 'vitest'
import { saveBackendAvailable, loadBackendAvailable, saveLocale, loadLocale } from '../src/storage'

class FakeStorage {
  store = new Map<string, string>()
  async setLocalStorage(key: string, value: string): Promise<boolean> {
    this.store.set(key, value)
    return true
  }
  async getLocalStorage(key: string): Promise<string> {
    return this.store.get(key) ?? ''
  }
}

describe('backendAvailable storage', () => {
  it('round-trips true/false through the bridge storage', async () => {
    const bridge = new FakeStorage()
    await saveBackendAvailable(bridge, true)
    expect(await loadBackendAvailable(bridge)).toBe(true)
    await saveBackendAvailable(bridge, false)
    expect(await loadBackendAvailable(bridge)).toBe(false)
  })

  it('returns null when nothing has been saved yet', async () => {
    const bridge = new FakeStorage()
    expect(await loadBackendAvailable(bridge)).toBeNull()
  })

  it('never stores anything other than the boolean flag under its key', async () => {
    const bridge = new FakeStorage()
    await saveBackendAvailable(bridge, true)
    const values = Array.from(bridge.store.values())
    expect(values).toEqual(['1'])
  })
})

describe('locale storage', () => {
  it('round-trips ja/en through the bridge storage', async () => {
    const bridge = new FakeStorage()
    await saveLocale(bridge, 'en')
    expect(await loadLocale(bridge)).toBe('en')
    await saveLocale(bridge, 'ja')
    expect(await loadLocale(bridge)).toBe('ja')
  })

  it('returns null when nothing has been saved yet', async () => {
    const bridge = new FakeStorage()
    expect(await loadLocale(bridge)).toBeNull()
  })

  it('returns null for a corrupted/unsupported stored value instead of throwing', async () => {
    const bridge = new FakeStorage()
    await bridge.setLocalStorage('even-calendar.locale', 'fr-FR')
    expect(await loadLocale(bridge)).toBeNull()
  })
})
