import { describe, expect, it } from 'vitest'
import { BridgePairingResumeStore, type PersistedPairingResume, type BridgeStorageLike } from '../../src/product/pairingResumeStore'

function fakeBridge(): BridgeStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    async setLocalStorage(key: string, value: string): Promise<boolean> {
      data.set(key, value)
      return true
    },
    async getLocalStorage(key: string): Promise<string> {
      return data.get(key) ?? ''
    },
  }
}

const SAMPLE: PersistedPairingResume = {
  pairingId: 'pairing-1',
  userCode: 'ABCD-EFGH',
  pollIntervalSeconds: 3,
  expiresAt: Date.now() + 600_000,
  exchangeCandidate: null,
}

describe('BridgePairingResumeStore', () => {
  it('returns null when nothing has been saved yet', async () => {
    const store = new BridgePairingResumeStore(fakeBridge())
    expect(await store.load()).toBeNull()
  })

  it('round-trips a save/load without a candidate', async () => {
    const store = new BridgePairingResumeStore(fakeBridge())
    await store.save(SAMPLE)
    expect(await store.load()).toEqual(SAMPLE)
  })

  it('round-trips a save/load including an exchange candidate', async () => {
    const store = new BridgePairingResumeStore(fakeBridge())
    const withCandidate: PersistedPairingResume = {
      ...SAMPLE,
      exchangeCandidate: { accessToken: 'a'.repeat(64), refreshToken: 'b'.repeat(64) },
    }
    await store.save(withCandidate)
    expect(await store.load()).toEqual(withCandidate)
  })

  it('clear() removes the saved record (load returns null afterward)', async () => {
    const bridge = fakeBridge()
    const store = new BridgePairingResumeStore(bridge)
    await store.save(SAMPLE)
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  it('returns null for corrupted JSON instead of throwing', async () => {
    const bridge = fakeBridge()
    bridge.data.set('even-calendar.pairingResume', '{not valid json')
    const store = new BridgePairingResumeStore(bridge)
    expect(await store.load()).toBeNull()
  })

  it('returns null when the stored shape is missing required fields', async () => {
    const bridge = fakeBridge()
    bridge.data.set('even-calendar.pairingResume', JSON.stringify({ pairingId: 'p-1' }))
    const store = new BridgePairingResumeStore(bridge)
    expect(await store.load()).toBeNull()
  })

  it('returns null when exchangeCandidate is present but malformed', async () => {
    const bridge = fakeBridge()
    bridge.data.set('even-calendar.pairingResume', JSON.stringify({ ...SAMPLE, exchangeCandidate: { accessToken: 'only-one-field' } }))
    const store = new BridgePairingResumeStore(bridge)
    expect(await store.load()).toBeNull()
  })
})
