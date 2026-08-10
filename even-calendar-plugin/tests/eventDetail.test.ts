import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEventDetailLines, formatEventDetailWhen, type EventDetail } from '../src/eventDetail'
import { resetActiveLocaleForTest, setActiveLocale } from '../src/i18n/locale'

function baseDetail(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    eventId: 'evt-1',
    title: 'Meeting',
    status: 'confirmed',
    allDay: false,
    startLocal: null,
    endLocal: null,
    startDate: null,
    endDateExclusive: null,
    location: null,
    description: null,
    attendees: null,
    meetingUrl: null,
    etag: null,
    ...overrides,
  }
}

describe('formatEventDetailWhen (ja, default locale)', () => {
  it('formats a same-day timed range as "M/D HH:mm-HH:mm"', () => {
    const detail = baseDetail({ startLocal: '2026-07-23T15:00:00', endLocal: '2026-07-23T16:00:00' })
    expect(formatEventDetailWhen(detail)).toBe('7/23 15:00-16:00')
  })

  it('formats a cross-day timed range as "M/D HH:mm〜M/D HH:mm"', () => {
    const detail = baseDetail({ startLocal: '2026-07-30T22:00:00', endLocal: '2026-07-31T02:00:00' })
    expect(formatEventDetailWhen(detail)).toBe('7/30 22:00〜7/31 02:00')
  })

  it('formats a start-only event as "M/D HH:mm〜"', () => {
    const detail = baseDetail({ startLocal: '2026-07-30T10:00:00', endLocal: null })
    expect(formatEventDetailWhen(detail)).toBe('7/30 10:00〜')
  })

  it('formats an end-only event as "〜M/D HH:mm"', () => {
    const detail = baseDetail({ startLocal: null, endLocal: '2026-07-30T10:00:00' })
    expect(formatEventDetailWhen(detail)).toBe('〜7/30 10:00')
  })

  it('formats an all-day multi-day event using the inclusive end date via allDayDisplay', () => {
    const detail = baseDetail({ allDay: true, startDate: '2026-08-03', endDateExclusive: '2026-08-06' })
    const text = formatEventDetailWhen(detail)
    expect(text).toBe('終日 8/3〜8/5')
    expect(text).not.toContain('8/6')
  })

  it('returns null when neither startLocal nor endLocal is present and not all-day', () => {
    expect(formatEventDetailWhen(baseDetail())).toBeNull()
  })

  it('returns null for an all-day event missing startDate', () => {
    expect(formatEventDetailWhen(baseDetail({ allDay: true, startDate: null }))).toBeNull()
  })
})

describe('formatEventDetailWhen (en)', () => {
  beforeEach(() => setActiveLocale('en'))
  afterEach(() => resetActiveLocaleForTest())

  it('formats a same-day timed range as "Mon D, HH:mm-HH:mm"', () => {
    const detail = baseDetail({ startLocal: '2026-07-23T15:00:00', endLocal: '2026-07-23T16:00:00' })
    expect(formatEventDetailWhen(detail)).toBe('Jul 23, 15:00-16:00')
  })

  it('formats a cross-day timed range as "Mon D, HH:mm to Mon D, HH:mm"', () => {
    const detail = baseDetail({ startLocal: '2026-07-30T22:00:00', endLocal: '2026-07-31T02:00:00' })
    expect(formatEventDetailWhen(detail)).toBe('Jul 30, 22:00 to Jul 31, 02:00')
  })

  it('formats a start-only event as "From Mon D, HH:mm"', () => {
    const detail = baseDetail({ startLocal: '2026-07-30T10:00:00', endLocal: null })
    expect(formatEventDetailWhen(detail)).toBe('From Jul 30, 10:00')
  })

  it('formats an end-only event as "Until Mon D, HH:mm"', () => {
    const detail = baseDetail({ startLocal: null, endLocal: '2026-07-30T10:00:00' })
    expect(formatEventDetailWhen(detail)).toBe('Until Jul 30, 10:00')
  })

  it('formats an all-day multi-day event using the inclusive end date, never the exclusive one', () => {
    const detail = baseDetail({ allDay: true, startDate: '2026-08-03', endDateExclusive: '2026-08-06' })
    const text = formatEventDetailWhen(detail)
    expect(text).toBe('All day, Aug 3 - Aug 5')
    expect(text).not.toContain('Aug 6')
  })

  it('returns null when neither startLocal nor endLocal is present and not all-day', () => {
    expect(formatEventDetailWhen(baseDetail())).toBeNull()
  })
})

describe('buildEventDetailLines field labels (en)', () => {
  beforeEach(() => setActiveLocale('en'))
  afterEach(() => resetActiveLocaleForTest())

  it('uses "Location:" for the location line', () => {
    const lines = buildEventDetailLines(baseDetail({ location: 'Room A' }))
    expect(lines.some((l) => l.startsWith('Location: Room A'))).toBe(true)
  })

  it('uses "Note:" for the description line', () => {
    const lines = buildEventDetailLines(baseDetail({ description: 'Bring laptop' }))
    expect(lines.some((l) => l.startsWith('Note: Bring laptop'))).toBe(true)
  })

  it('uses "Attendees:" for the attendee line', () => {
    const lines = buildEventDetailLines(
      baseDetail({ attendees: [{ email: 'a@example.com', displayName: 'Alice', responseStatus: 'accepted' }] }),
    )
    expect(lines.some((l) => l.startsWith('Attendees: Alice'))).toBe(true)
  })

  it('uses "Meeting URL:" for the meeting URL line', () => {
    const lines = buildEventDetailLines(baseDetail({ meetingUrl: 'https://meet.example.com/x' }))
    expect(lines.some((l) => l.startsWith('Meeting URL: https://meet.example.com/x'))).toBe(true)
  })

  it('omits lines for fields that are not set', () => {
    const lines = buildEventDetailLines(baseDetail())
    expect(lines).toEqual([])
  })
})

describe('buildEventDetailLines field labels (ja, default locale)', () => {
  it('uses the existing Japanese labels unchanged', () => {
    const lines = buildEventDetailLines(baseDetail({ location: '会議室A', description: 'メモ', meetingUrl: 'https://meet.example.com/x' }))
    expect(lines.some((l) => l.startsWith('場所: 会議室A'))).toBe(true)
    expect(lines.some((l) => l.startsWith('メモ: メモ'))).toBe(true)
    expect(lines.some((l) => l.startsWith('会議URL: https://meet.example.com/x'))).toBe(true)
  })
})
