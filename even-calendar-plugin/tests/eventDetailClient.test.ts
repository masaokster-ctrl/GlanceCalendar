import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchEventDetail, updateCalendarEventDetail, deleteCalendarEventDetail } from '../src/eventDetailClient'

const BASE_PARAMS = {
  eventId: 'evt-1',
  baseUrl: 'https://backend.test',
  sessionToken: 'test-session-token',
  installId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function validEventBody(): unknown {
  return {
    schemaVersion: '1',
    event: { eventId: 'evt-1', title: 'Meeting', status: 'confirmed', allDay: false },
  }
}

describe('fetchEventDetail (GET) locale wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds ?locale=en to the URL when locale is specified', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validEventBody()))
    vi.stubGlobal('fetch', fetchMock)
    await fetchEventDetail({ ...BASE_PARAMS, locale: 'en', signal: new AbortController().signal })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/calendar-events/evt-1?locale=en')
  })

  it('sends the exact same URL as before when locale is not specified', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, validEventBody()))
    vi.stubGlobal('fetch', fetchMock)
    await fetchEventDetail({ ...BASE_PARAMS, signal: new AbortController().signal })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/calendar-events/evt-1')
  })
})

describe('updateCalendarEventDetail (PATCH) — locale is out of scope, must not appear', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not send a locale query param or body field even if globally active', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { eventId: 'evt-1' }))
    vi.stubGlobal('fetch', fetchMock)
    await updateCalendarEventDetail({
      ...BASE_PARAMS,
      idempotencyKey: 'idem-1',
      fields: { title: 'New title' },
      signal: new AbortController().signal,
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/calendar-events/evt-1')
    expect(JSON.parse(String(init.body))).not.toHaveProperty('locale')
  })
})

describe('deleteCalendarEventDetail (DELETE) — locale is out of scope, must not appear', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not add a locale query param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { eventId: 'evt-1' }))
    vi.stubGlobal('fetch', fetchMock)
    await deleteCalendarEventDetail({ ...BASE_PARAMS, idempotencyKey: 'idem-1', signal: new AbortController().signal })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://backend.test/plugin/calendar-events/evt-1?idempotencyKey=idem-1')
  })
})
