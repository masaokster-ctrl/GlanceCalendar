import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseUpcomingEventsResult, formatUpcomingEventLine } from '../src/upcomingEvents'
import type { DayEventItem } from '../src/dayEvents'
import { resetActiveLocaleForTest, setActiveLocale } from '../src/i18n/locale'

function timed(overrides: Partial<DayEventItem> = {}): DayEventItem {
  return {
    eventId: 'k',
    title: 'title',
    allDay: false,
    startLocal: '2026-07-23T14:00:00',
    endLocal: '2026-07-23T15:00:00',
    startDate: null,
    endDateExclusive: null,
    ...overrides,
  }
}

describe('parseUpcomingEventsResult', () => {
  const validRaw = {
    schemaVersion: '1',
    mode: 'upcoming',
    timeZone: 'Asia/Tokyo',
    events: [{ eventId: 'k1', title: '打ち合わせ', allDay: false, startLocal: '2026-07-23T14:00:00', endLocal: '2026-07-23T15:00:00' }],
    truncated: false,
  }

  it('parses a valid result', () => {
    const result = parseUpcomingEventsResult(validRaw)
    expect(result?.mode).toBe('upcoming')
    expect(result?.events).toHaveLength(1)
  })

  it('rejects an invalid schemaVersion', () => {
    expect(parseUpcomingEventsResult({ ...validRaw, schemaVersion: '2' })).toBeNull()
  })

  it('rejects a mode other than "upcoming"', () => {
    expect(parseUpcomingEventsResult({ ...validRaw, mode: 'day' })).toBeNull()
  })

  it('rejects a non-Asia/Tokyo timeZone', () => {
    expect(parseUpcomingEventsResult({ ...validRaw, timeZone: 'UTC' })).toBeNull()
  })

  it('rejects a missing truncated flag', () => {
    const withoutTruncated: Record<string, unknown> = { ...validRaw }
    delete withoutTruncated.truncated
    expect(parseUpcomingEventsResult(withoutTruncated)).toBeNull()
  })

  it('rejects when any event item is malformed', () => {
    expect(parseUpcomingEventsResult({ ...validRaw, events: [{ eventId: 'k', title: '', allDay: false }] })).toBeNull()
  })

  it('accepts an all-day event item using the same shape as the day endpoint', () => {
    const result = parseUpcomingEventsResult({
      ...validRaw,
      events: [{ eventId: 'k2', title: '休暇', allDay: true, startDate: '2026-07-24', endDateExclusive: '2026-07-25' }],
    })
    expect(result?.events[0]).toEqual({
      eventId: 'k2',
      title: '休暇',
      allDay: true,
      startLocal: null,
      endLocal: null,
      startDate: '2026-07-24',
      endDateExclusive: '2026-07-25',
    })
  })

  it('accepts zero events', () => {
    const result = parseUpcomingEventsResult({ ...validRaw, events: [] })
    expect(result?.events).toEqual([])
  })

  it('rejects non-object input', () => {
    expect(parseUpcomingEventsResult(null)).toBeNull()
    expect(parseUpcomingEventsResult('x')).toBeNull()
  })

  it('never contains day or dateLocal fields shaping the result type', () => {
    const result = parseUpcomingEventsResult(validRaw)
    expect(result).not.toHaveProperty('day')
    expect(result).not.toHaveProperty('dateLocal')
  })
})

describe('formatUpcomingEventLine', () => {
  it('formats a same-year timed event as "M/D HH:mm-HH:mm title"', () => {
    expect(formatUpcomingEventLine(timed(), 2026)).toBe('7/23 14:00-15:00 title')
  })

  it('formats an all-day event as "M/D 終日 title"', () => {
    const event: DayEventItem = { eventId: 'k', title: '休暇', allDay: true, startLocal: null, endLocal: null, startDate: '2026-07-24', endDateExclusive: '2026-07-25' }
    expect(formatUpcomingEventLine(event, 2026)).toBe('7/24 終日 休暇')
  })

  it('uses YYYY/M/D when the event year differs from the reference year', () => {
    const event = timed({ startLocal: '2027-01-01T09:00:00', endLocal: '2027-01-01T10:00:00' })
    expect(formatUpcomingEventLine(event, 2026)).toBe('2027/1/1 09:00-10:00 title')
  })

  it('uses M/D (no year) when the event year matches the reference year', () => {
    const event = timed({ startLocal: '2026-12-31T09:00:00', endLocal: '2026-12-31T10:00:00' })
    expect(formatUpcomingEventLine(event, 2026)).not.toMatch(/^2026\//)
  })

  it('truncates a long title to ~20 characters with an ellipsis', () => {
    const event = timed({ title: 'x'.repeat(50) })
    const line = formatUpcomingEventLine(event, 2026)
    expect(line).toContain('…')
  })

  it('falls back to just the title when startLocal is missing for a non-all-day event', () => {
    const event = timed({ startLocal: null, endLocal: null })
    expect(formatUpcomingEventLine(event, 2026)).toBe('title')
  })

  it('never uses the day-context continuation wording (前日から/翌日へ/継続中)', () => {
    const event = timed()
    const line = formatUpcomingEventLine(event, 2026)
    expect(line).not.toContain('前日から')
    expect(line).not.toContain('翌日へ')
    expect(line).not.toContain('継続中')
  })
})

describe('formatUpcomingEventLine (en)', () => {
  beforeEach(() => setActiveLocale('en'))
  afterEach(() => resetActiveLocaleForTest())

  it('formats a same-year timed event as "Mon D HH:mm-HH:mm title" (no year prefix)', () => {
    expect(formatUpcomingEventLine(timed(), 2026)).toBe('Jul 23 14:00-15:00 title')
  })

  it('formats a year-crossing timed event as "Mon D, YYYY HH:mm-HH:mm title"', () => {
    const event = timed({ startLocal: '2027-01-01T09:00:00', endLocal: '2027-01-01T10:00:00' })
    expect(formatUpcomingEventLine(event, 2026)).toBe('Jan 1, 2027 09:00-10:00 title')
  })

  it('formats an all-day event as "Mon D All day title"', () => {
    const event: DayEventItem = { eventId: 'k', title: 'Vacation', allDay: true, startLocal: null, endLocal: null, startDate: '2026-07-24', endDateExclusive: '2026-07-25' }
    expect(formatUpcomingEventLine(event, 2026)).toBe('Jul 24 All day Vacation')
  })

  it('does not swap same-year/year-crossing forms with each other', () => {
    const sameYear = formatUpcomingEventLine(timed({ startLocal: '2026-12-31T09:00:00', endLocal: '2026-12-31T10:00:00' }), 2026)
    expect(sameYear).not.toContain('2026,')
    expect(sameYear.startsWith('Dec 31')).toBe(true)

    const crossing = formatUpcomingEventLine(timed({ startLocal: '2027-01-01T09:00:00', endLocal: '2027-01-01T10:00:00' }), 2026)
    expect(crossing).toContain('2027')
  })
})
