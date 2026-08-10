import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeFollowupAudio } from '../src/followupAudioClient'

const BASE_PARAMS = {
  wav: new Uint8Array([1, 2, 3, 4]),
  baseUrl: 'https://backend.test',
  sessionToken: 'test-session-token',
  installId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function validResultBody(): unknown {
  return {
    requestId: BASE_PARAMS.requestId,
    conversationId: BASE_PARAMS.conversationId,
    result: {
      schemaVersion: '1',
      resultType: 'cancelled',
      title: null,
      startLocal: null,
      endLocal: null,
      startDate: null,
      endDateExclusive: null,
      timeZone: 'Asia/Tokyo',
      allDay: false,
      clarificationField: null,
      clarificationQuestion: null,
      assumptions: [],
    },
  }
}

describe('analyzeFollowupAudio locale wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds ?locale=en to the URL when locale is specified', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validResultBody()))
    vi.stubGlobal('fetch', fetchMock)
    await analyzeFollowupAudio({ ...BASE_PARAMS, locale: 'en', signal: new AbortController().signal })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/analyze-followup-audio?locale=en')
  })

  it('sends the exact same URL as before when locale is not specified', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validResultBody()))
    vi.stubGlobal('fetch', fetchMock)
    await analyzeFollowupAudio({ ...BASE_PARAMS, signal: new AbortController().signal })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/analyze-followup-audio')
  })
})
