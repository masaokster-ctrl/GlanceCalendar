import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDayEventItem, parseDayEventsResult, sortEventsForDisplay, formatDayEventLine, type DayEventItem } from '../src/dayEvents'
import { resetActiveLocaleForTest, setActiveLocale } from '../src/i18n/locale'

function timed(overrides: Partial<DayEventItem> = {}): DayEventItem {
  return {
    eventId: 'k',
    title: 'title',
    allDay: false,
    startLocal: '2026-07-23T09:00:00',
    endLocal: '2026-07-23T10:00:00',
    startDate: null,
    endDateExclusive: null,
    ...overrides,
  }
}

describe('parseDayEventItem', () => {
  it('parses a valid timed event', () => {
    const item = parseDayEventItem({ eventId: 'k1', title: '朝会', allDay: false, startLocal: '2026-07-23T09:00:00', endLocal: '2026-07-23T10:00:00' })
    expect(item).toEqual({ eventId: 'k1', title: '朝会', allDay: false, startLocal: '2026-07-23T09:00:00', endLocal: '2026-07-23T10:00:00', startDate: null, endDateExclusive: null })
  })

  it('parses a valid all-day event', () => {
    const item = parseDayEventItem({ eventId: 'k2', title: '休暇', allDay: true, startDate: '2026-07-23', endDateExclusive: '2026-07-24' })
    expect(item).toEqual({ eventId: 'k2', title: '休暇', allDay: true, startLocal: null, endLocal: null, startDate: '2026-07-23', endDateExclusive: '2026-07-24' })
  })

  it('rejects a missing eventId', () => {
    expect(parseDayEventItem({ title: 'x', allDay: false, startLocal: '2026-07-23T09:00:00', endLocal: '2026-07-23T10:00:00' })).toBeNull()
  })

  it('rejects an empty title', () => {
    expect(parseDayEventItem({ eventId: 'k', title: '', allDay: false, startLocal: '2026-07-23T09:00:00', endLocal: '2026-07-23T10:00:00' })).toBeNull()
  })

  it('rejects an all-day event missing startDate/endDateExclusive', () => {
    expect(parseDayEventItem({ eventId: 'k', title: 'x', allDay: true })).toBeNull()
  })

  it('rejects malformed local datetime/date formats', () => {
    expect(parseDayEventItem({ eventId: 'k', title: 'x', allDay: false, startLocal: 'not-a-date', endLocal: '2026-07-23T10:00:00' })).toEqual(
      expect.objectContaining({ startLocal: null }),
    )
    expect(parseDayEventItem({ eventId: 'k', title: 'x', allDay: true, startDate: 'bad', endDateExclusive: '2026-07-24' })).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(parseDayEventItem(null)).toBeNull()
    expect(parseDayEventItem('string')).toBeNull()
  })
})

describe('parseDayEventsResult', () => {
  const validRaw = {
    schemaVersion: '1',
    day: 'today',
    dateLocal: '2026-07-23',
    timeZone: 'Asia/Tokyo',
    events: [{ eventId: 'k1', title: '朝会', allDay: false, startLocal: '2026-07-23T09:00:00', endLocal: '2026-07-23T10:00:00' }],
    truncated: false,
  }

  it('parses a valid result', () => {
    const result = parseDayEventsResult(validRaw)
    expect(result?.day).toBe('today')
    expect(result?.events).toHaveLength(1)
  })

  it('rejects an invalid schemaVersion', () => {
    expect(parseDayEventsResult({ ...validRaw, schemaVersion: '2' })).toBeNull()
  })

  it('rejects an invalid day value', () => {
    expect(parseDayEventsResult({ ...validRaw, day: 'someday' })).toBeNull()
  })

  it('rejects day:"yesterday" (removed in Phase 2G; only today/tomorrow remain valid)', () => {
    expect(parseDayEventsResult({ ...validRaw, day: 'yesterday', dateLocal: '2026-07-22' })).toBeNull()
  })

  it('rejects a non-Asia/Tokyo timeZone', () => {
    expect(parseDayEventsResult({ ...validRaw, timeZone: 'UTC' })).toBeNull()
  })

  it('rejects a malformed dateLocal', () => {
    expect(parseDayEventsResult({ ...validRaw, dateLocal: '2026/07/23' })).toBeNull()
  })

  it('rejects when any event item is malformed', () => {
    expect(parseDayEventsResult({ ...validRaw, events: [{ eventId: 'k', title: '', allDay: false }] })).toBeNull()
  })

  it('rejects a missing truncated flag', () => {
    const withoutTruncated: Record<string, unknown> = { ...validRaw }
    delete withoutTruncated.truncated
    expect(parseDayEventsResult(withoutTruncated)).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(parseDayEventsResult(null)).toBeNull()
    expect(parseDayEventsResult([])).toBeNull()
  })
})

describe('sortEventsForDisplay', () => {
  it('puts all-day events before timed events', () => {
    const events: DayEventItem[] = [
      timed({ eventId: 't1', startLocal: '2026-07-23T09:00:00' }),
      { eventId: 'a1', title: 'allday', allDay: true, startLocal: null, endLocal: null, startDate: '2026-07-23', endDateExclusive: '2026-07-24' },
    ]
    const sorted = sortEventsForDisplay(events)
    expect(sorted[0]?.allDay).toBe(true)
    expect(sorted[1]?.allDay).toBe(false)
  })

  it('sorts timed events by start time ascending', () => {
    const events: DayEventItem[] = [
      timed({ eventId: 'late', startLocal: '2026-07-23T15:00:00' }),
      timed({ eventId: 'early', startLocal: '2026-07-23T09:00:00' }),
    ]
    const sorted = sortEventsForDisplay(events)
    expect(sorted.map((e) => e.eventId)).toEqual(['early', 'late'])
  })

  it('does not mutate the input array', () => {
    const events: DayEventItem[] = [timed({ eventId: 'b', startLocal: '2026-07-23T15:00:00' }), timed({ eventId: 'a', startLocal: '2026-07-23T09:00:00' })]
    const original = [...events]
    sortEventsForDisplay(events)
    expect(events).toEqual(original)
  })
})

describe('formatDayEventLine', () => {
  it('formats a same-day timed event as "HH:mm-HH:mm title"', () => {
    expect(formatDayEventLine(timed(), '2026-07-23')).toBe('09:00-10:00 title')
  })

  it('formats an all-day event as "終日 title"', () => {
    const event: DayEventItem = { eventId: 'k', title: '休暇', allDay: true, startLocal: null, endLocal: null, startDate: '2026-07-23', endDateExclusive: '2026-07-24' }
    expect(formatDayEventLine(event, '2026-07-23')).toBe('終日 休暇')
  })

  it('formats an event continuing from the previous day as "前日から-HH:mm"', () => {
    const event = timed({ startLocal: '2026-07-22T22:00:00', endLocal: '2026-07-23T10:00:00' })
    expect(formatDayEventLine(event, '2026-07-23')).toBe('前日から-10:00 title')
  })

  it('formats an event continuing into the next day as "HH:mm-翌日へ"', () => {
    const event = timed({ startLocal: '2026-07-23T22:00:00', endLocal: '2026-07-24T10:00:00' })
    expect(formatDayEventLine(event, '2026-07-23')).toBe('22:00-翌日へ title')
  })

  it('formats an event spanning the entire boundary day as "継続中"', () => {
    const event = timed({ startLocal: '2026-07-22T10:00:00', endLocal: '2026-07-24T10:00:00' })
    expect(formatDayEventLine(event, '2026-07-23')).toBe('継続中 title')
  })

  it('never uses "終日" wording for a multi-day timed event (must not be confused with an all-day event)', () => {
    const event = timed({ startLocal: '2026-07-22T22:00:00', endLocal: '2026-07-23T10:00:00' })
    expect(formatDayEventLine(event, '2026-07-23')).not.toContain('終日')
  })

  it('truncates a long title to ~20 characters with an ellipsis', () => {
    const event = timed({ title: 'x'.repeat(50) })
    const line = formatDayEventLine(event, '2026-07-23')
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(50)
  })

  it('falls back to just the title when startLocal/endLocal are missing for a non-all-day event', () => {
    const event = timed({ startLocal: null, endLocal: null })
    expect(formatDayEventLine(event, '2026-07-23')).toBe('title')
  })
})

describe('formatDayEventLine (en)', () => {
  beforeEach(() => setActiveLocale('en'))
  afterEach(() => resetActiveLocaleForTest())

  it('formats a same-day timed event as "HH:mm-HH:mm title"', () => {
    expect(formatDayEventLine(timed(), '2026-07-23')).toBe('09:00-10:00 title')
  })

  it('formats an all-day event as "All day title"', () => {
    const event: DayEventItem = { eventId: 'k', title: 'Vacation', allDay: true, startLocal: null, endLocal: null, startDate: '2026-07-23', endDateExclusive: '2026-07-24' }
    expect(formatDayEventLine(event, '2026-07-23')).toBe('All day Vacation')
  })

  it('formats an event continuing from the previous day as "From prev day-HH:mm title"', () => {
    const event = timed({ startLocal: '2026-07-22T22:00:00', endLocal: '2026-07-23T10:00:00' })
    expect(formatDayEventLine(event, '2026-07-23')).toBe('From prev day-10:00 title')
  })

  it('formats an event continuing into the next day as "HH:mm-next day title"', () => {
    const event = timed({ startLocal: '2026-07-23T22:00:00', endLocal: '2026-07-24T10:00:00' })
    expect(formatDayEventLine(event, '2026-07-23')).toBe('22:00-next day title')
  })

  it('formats an event spanning the entire boundary day as "Ongoing title"', () => {
    const event = timed({ startLocal: '2026-07-22T10:00:00', endLocal: '2026-07-24T10:00:00' })
    expect(formatDayEventLine(event, '2026-07-23')).toBe('Ongoing title')
  })

  it('never uses "All day" wording for a multi-day timed event (must stay distinct from an all-day event)', () => {
    const spansBoundary = timed({ startLocal: '2026-07-22T10:00:00', endLocal: '2026-07-24T10:00:00' })
    const fromPrevDay = timed({ startLocal: '2026-07-22T22:00:00', endLocal: '2026-07-23T10:00:00' })
    const toNextDay = timed({ startLocal: '2026-07-23T22:00:00', endLocal: '2026-07-24T10:00:00' })
    expect(formatDayEventLine(spansBoundary, '2026-07-23')).not.toContain('All day')
    expect(formatDayEventLine(fromPrevDay, '2026-07-23')).not.toContain('All day')
    expect(formatDayEventLine(toNextDay, '2026-07-23')).not.toContain('All day')
  })
})
