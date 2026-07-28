import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkBackendHealth } from '../src/backendHealth'

describe('checkBackendHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns true for a 200 response with status "ok"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }),
    )
    expect(await checkBackendHealth('https://example.test')).toBe(true)
  })

  it('returns false for a non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    expect(await checkBackendHealth('https://example.test')).toBe(false)
  })

  it('returns false when the body does not contain status "ok"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'degraded' }) }))
    expect(await checkBackendHealth('https://example.test')).toBe(false)
  })

  it('returns false (not throw) when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(checkBackendHealth('https://example.test')).resolves.toBe(false)
  })

  it('does not send an Authorization header or a request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) })
    vi.stubGlobal('fetch', fetchMock)
    await checkBackendHealth('https://example.test')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.test/health')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect((init.headers ?? {})['Authorization']).toBeUndefined()
  })

  it('aborts after the timeout and resolves false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }),
    )
    const result = await checkBackendHealth('https://example.test', 10)
    expect(result).toBe(false)
  })
})
