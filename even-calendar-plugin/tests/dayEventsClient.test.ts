import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDayEvents } from '../src/dayEventsClient'

const BASE_PARAMS = {
  day: 'today' as const,
  baseUrl: 'https://backend.test',
  sessionToken: 'test-session-token',
  installId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function validResultBody(): unknown {
  return {
    schemaVersion: '1',
    day: 'today',
    dateLocal: '2026-07-23',
    timeZone: 'Asia/Tokyo',
    events: [],
    truncated: false,
  }
}

describe('fetchDayEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns success with the parsed result for a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, validResultBody())))
    const outcome = await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.result.day).toBe('today')
    }
  })

  it('sends a GET request with the required headers and day query param, no body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validResultBody()))
    vi.stubGlobal('fetch', fetchMock)
    await fetchDayEvents({ ...BASE_PARAMS, day: 'tomorrow', signal: new AbortController().signal })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/calendar-events/day?day=tomorrow')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-session-token')
    expect(headers['X-Install-Id']).toBe(BASE_PARAMS.installId)
    expect(headers['X-Request-Id']).toBe(BASE_PARAMS.requestId)
  })

  it('adds locale=en to the query string when locale is specified', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validResultBody()))
    vi.stubGlobal('fetch', fetchMock)
    await fetchDayEvents({ ...BASE_PARAMS, locale: 'en', signal: new AbortController().signal })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/calendar-events/day?day=today&locale=en')
  })

  it('sends the exact same URL as before when locale is not specified', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validResultBody()))
    vi.stubGlobal('fetch', fetchMock)
    await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/calendar-events/day?day=today')
  })

  it('maps 401 to auth_failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    expect((await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('auth_failed')
  })

  it('maps 403 to forbidden', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })))
    expect((await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('forbidden')
  })

  it('maps 429 to rate_limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429 })))
    expect((await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('rate_limited')
  })

  it('maps 504 to timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 504 })))
    expect((await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('timeout')
  })

  it('maps 400/502 to failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 400 })))
    expect((await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('failed')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 502 })))
    expect((await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('failed')
  })

  it('returns failed for malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json{{', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    expect((await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('failed')
  })

  it('returns failed when the response does not satisfy the schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { foo: 'bar' })))
    expect((await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('failed')
  })

  it('returns aborted immediately if the signal is already aborted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    const outcome = await fetchDayEvents({ ...BASE_PARAMS, signal: controller.signal })
    expect(outcome.kind).toBe('aborted')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns aborted when the caller cancels mid-flight', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }),
    )
    const controller = new AbortController()
    const promise = fetchDayEvents({ ...BASE_PARAMS, signal: controller.signal })
    controller.abort()
    expect((await promise).kind).toBe('aborted')
  })

  it('returns timeout when the internal timer fires (not caused by caller cancellation)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }),
    )
    const outcome = await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal, timeoutMs: 20 })
    expect(outcome.kind).toBe('timeout')
  })

  it('returns network_error for a genuine fetch failure unrelated to any abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const outcome = await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })
    expect(outcome.kind).toBe('network_error')
  })

  it('does not automatically retry on failure (fetch called exactly once)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchDayEvents({ ...BASE_PARAMS, signal: new AbortController().signal })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
