import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeAudio } from '../src/analyzeAudioClient'

const BASE_PARAMS = {
  wav: new Uint8Array([1, 2, 3, 4]),
  baseUrl: 'https://backend.test',
  sessionToken: 'test-session-token',
  installId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function validResult(): Record<string, unknown> {
  return {
    schemaVersion: '1',
    resultType: 'event_candidate',
    title: '打ち合わせ',
    startLocal: '2026-07-23T15:00:00',
    endLocal: '2026-07-23T16:00:00',
    timeZone: 'Asia/Tokyo',
    allDay: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions: [],
  }
}

function validResultBody(): unknown {
  return { requestId: BASE_PARAMS.requestId, result: validResult() }
}

describe('analyzeAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns success with the parsed result for a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, validResultBody())))
    const outcome = await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.requestId).toBe(BASE_PARAMS.requestId)
      expect(outcome.result.resultType).toBe('event_candidate')
    }
  })

  it('sends the required headers and raw WAV body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validResultBody()))
    vi.stubGlobal('fetch', fetchMock)
    await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/analyze-audio')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('audio/wav')
    expect(headers.Authorization).toBe('Bearer test-session-token')
    expect(headers['X-Install-Id']).toBe(BASE_PARAMS.installId)
    expect(headers['X-Request-Id']).toBe(BASE_PARAMS.requestId)
  })

  it('maps 401/403 to auth_failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    expect((await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('auth_failed')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })))
    expect((await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('auth_failed')
  })

  it('maps 429 to rate_limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429 })))
    expect((await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('rate_limited')
  })

  it('maps 504 to timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 504 })))
    expect((await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('timeout')
  })

  it('maps other non-ok statuses to failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 502 })))
    expect((await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('failed')
  })

  it('returns failed for malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not json{{', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    )
    expect((await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('failed')
  })

  it('returns failed when requestId is missing from the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { result: validResult() })))
    expect((await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('failed')
  })

  it('returns failed when the result does not satisfy the schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { requestId: BASE_PARAMS.requestId, result: { foo: 'bar' } })))
    expect((await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })).kind).toBe('failed')
  })

  it('returns aborted immediately if the signal is already aborted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    const outcome = await analyzeAudio({ ...BASE_PARAMS, signal: controller.signal })
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
    const promise = analyzeAudio({ ...BASE_PARAMS, signal: controller.signal })
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
    const outcome = await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal, timeoutMs: 20 })
    expect(outcome.kind).toBe('timeout')
  })

  it('returns network_error for a genuine fetch failure unrelated to any abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const outcome = await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })
    expect(outcome.kind).toBe('network_error')
  })

  it('does not automatically retry on failure (fetch called exactly once)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    await analyzeAudio({ ...BASE_PARAMS, signal: new AbortController().signal })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
