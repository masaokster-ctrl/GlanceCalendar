import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCalendarEvent, checkCalendarEventStatus } from '../src/calendarRegistrationClient'

const TIMED_PARAMS = {
  baseUrl: 'https://backend.test',
  sessionToken: 'test-session-token',
  installId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  candidateId: 'cand-1',
  title: 'Meeting',
  timeZone: 'Asia/Tokyo',
  allDay: false as const,
  startLocal: '2026-07-23T15:00:00',
  endLocal: '2026-07-23T16:00:00',
}

function okResponse(): Response {
  return new Response(null, { status: 200 })
}

describe('registerCalendarEvent locale wiring (body only, this is the sole client that sends locale in JSON body)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('includes locale:"en" in the JSON body when locale is specified', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await registerCalendarEvent({ ...TIMED_PARAMS, locale: 'en', signal: new AbortController().signal })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/calendar-events')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.locale).toBe('en')
  })

  it('omits the locale key entirely from the JSON body when locale is not specified (byte-identical to prior behavior)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await registerCalendarEvent({ ...TIMED_PARAMS, signal: new AbortController().signal })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect('locale' in body).toBe(false)
  })
})

describe('checkCalendarEventStatus — locale is out of scope, must not appear', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never adds a locale query param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await checkCalendarEventStatus({
      baseUrl: 'https://backend.test',
      sessionToken: 'test-session-token',
      installId: '11111111-1111-4111-8111-111111111111',
      candidateId: 'cand-1',
    })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/calendar-events/status?candidateId=cand-1')
  })
})
