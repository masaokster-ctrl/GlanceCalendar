import { describe, expect, it } from 'vitest'
import { getOrCreateInstallationId } from '../../src/product/installationId'

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('getOrCreateInstallationId', () => {
  it('generates a v4-shaped UUID on first call and persists it', async () => {
    const storage = new FakeStorage()
    const id = await getOrCreateInstallationId(storage)
    expect(id).toMatch(UUID_PATTERN)
    expect(await storage.getLocalStorage('even-calendar.installationId')).toBe(id)
  })

  it('returns the same id on subsequent calls (does not regenerate)', async () => {
    const storage = new FakeStorage()
    const first = await getOrCreateInstallationId(storage)
    const second = await getOrCreateInstallationId(storage)
    expect(second).toBe(first)
  })

  it('ignores a corrupted stored value and regenerates', async () => {
    const storage = new FakeStorage()
    await storage.setLocalStorage('even-calendar.installationId', 'not-a-uuid')
    const id = await getOrCreateInstallationId(storage)
    expect(id).toMatch(UUID_PATTERN)
  })

  it('generates different ids for different fresh storages (CSPRNG-backed)', async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => getOrCreateInstallationId(new FakeStorage())))
    expect(new Set(ids).size).toBe(20)
  })
})
