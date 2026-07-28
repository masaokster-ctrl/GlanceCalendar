import { describe, expect, it } from 'vitest'
import { saveBackendAvailable, loadBackendAvailable } from '../src/storage'

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
