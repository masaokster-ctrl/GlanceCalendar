import { describe, expect, it } from 'vitest'
import {
  MONTH_ABBR_EN,
  monthDayEn,
  monthDayYearEn,
  formatTimeRangeEn,
  formatCandidateWhenEn,
  formatCrossDayRangeEn,
  formatStartOnlyEn,
  formatEndOnlyEn,
  formatAllDaySingleEn,
  formatAllDayRangeEn,
  formatAllDayLinePrefixEn,
  formatOngoingLinePrefixEn,
  formatContinuedFromPrevDayEn,
  formatContinuesToNextDayEn,
} from '../../src/i18n/dateFormats'

describe('MONTH_ABBR_EN', () => {
  it('has exactly 12 entries, with Jan first and Dec last', () => {
    expect(MONTH_ABBR_EN).toHaveLength(12)
    expect(MONTH_ABBR_EN[0]).toBe('Jan')
    expect(MONTH_ABBR_EN[11]).toBe('Dec')
  })
})

describe('monthDayEn', () => {
  it('formats "YYYY-MM-DD" as "Mon D"', () => {
    expect(monthDayEn('2026-08-03')).toBe('Aug 3')
  })
})

describe('monthDayYearEn', () => {
  it('formats "YYYY-MM-DD" as "Mon D, YYYY" (year-crossing upcoming prefix)', () => {
    expect(monthDayYearEn('2027-07-23')).toBe('Jul 23, 2027')
  })
})

describe('formatTimeRangeEn', () => {
  it('joins monthDay/start/end with the fixed comma+hyphen shape', () => {
    expect(formatTimeRangeEn('Jul 23', '15:00', '16:00')).toBe('Jul 23, 15:00-16:00')
  })
})

describe('formatCandidateWhenEn', () => {
  it('builds "Mon D, HH:mm-HH:mm" from numeric parts', () => {
    expect(formatCandidateWhenEn({ month: 8, day: 3, hour: 10, minute: 0 }, { hour: 11, minute: 30 })).toBe('Aug 3, 10:00-11:30')
  })

  it('zero-pads single-digit hour/minute on both start and end', () => {
    expect(formatCandidateWhenEn({ month: 8, day: 3, hour: 9, minute: 5 }, { hour: 9, minute: 5 })).toBe('Aug 3, 09:05-09:05')
  })
})

describe('formatCrossDayRangeEn', () => {
  it('formats a start/end pair spanning two different days', () => {
    expect(formatCrossDayRangeEn('Jul 30', '22:00', 'Jul 31', '02:00')).toBe('Jul 30, 22:00 to Jul 31, 02:00')
  })
})

describe('formatStartOnlyEn', () => {
  it('prefixes with "From "', () => {
    expect(formatStartOnlyEn('Jul 30', '10:00')).toBe('From Jul 30, 10:00')
  })
})

describe('formatEndOnlyEn', () => {
  it('prefixes with "Until "', () => {
    expect(formatEndOnlyEn('Jul 30', '10:00')).toBe('Until Jul 30, 10:00')
  })
})

describe('formatAllDaySingleEn', () => {
  it('formats a single all-day date', () => {
    expect(formatAllDaySingleEn('Jul 30')).toBe('All day, Jul 30')
  })
})

describe('formatAllDayRangeEn', () => {
  it('formats an inclusive all-day range with a plain hyphen separator', () => {
    expect(formatAllDayRangeEn('Aug 3', 'Aug 5')).toBe('All day, Aug 3 - Aug 5')
  })
})

describe('list-line helpers', () => {
  it('formatAllDayLinePrefixEn returns "All day"', () => {
    expect(formatAllDayLinePrefixEn()).toBe('All day')
  })

  it('formatOngoingLinePrefixEn returns "Ongoing" (distinct wording from all-day)', () => {
    expect(formatOngoingLinePrefixEn()).toBe('Ongoing')
  })

  it('formatContinuedFromPrevDayEn formats "From prev day-HH:mm"', () => {
    expect(formatContinuedFromPrevDayEn('16:00')).toBe('From prev day-16:00')
  })

  it('formatContinuesToNextDayEn formats "HH:mm-next day"', () => {
    expect(formatContinuesToNextDayEn('22:00')).toBe('22:00-next day')
  })
})

describe('no forbidden glyphs (G2 font glyph-gap avoidance)', () => {
  const samples: string[] = [
    monthDayEn('2026-08-03'),
    monthDayYearEn('2027-07-23'),
    formatTimeRangeEn('Jul 23', '15:00', '16:00'),
    formatCandidateWhenEn({ month: 8, day: 3, hour: 10, minute: 0 }, { hour: 11, minute: 30 }),
    formatCrossDayRangeEn('Jul 30', '22:00', 'Jul 31', '02:00'),
    formatStartOnlyEn('Jul 30', '10:00'),
    formatEndOnlyEn('Jul 30', '10:00'),
    formatAllDaySingleEn('Jul 30'),
    formatAllDayRangeEn('Aug 3', 'Aug 5'),
    formatAllDayLinePrefixEn(),
    formatOngoingLinePrefixEn(),
    formatContinuedFromPrevDayEn('16:00'),
    formatContinuesToNextDayEn('22:00'),
  ]

  it('never contains the full-width tilde (〜)', () => {
    for (const sample of samples) expect(sample).not.toContain('〜')
  })

  it('never contains an en dash (–)', () => {
    for (const sample of samples) expect(sample).not.toContain('–')
  })
})
