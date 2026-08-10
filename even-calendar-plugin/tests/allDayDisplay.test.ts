import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatAllDayWhen, inclusiveEndDate, isValidLocalDate } from '../src/allDayDisplay'
import { resetActiveLocaleForTest, setActiveLocale } from '../src/i18n/locale'

// formatAllDayWhen/inclusiveEndDateはこれまで直接のユニットテストが無く(app.test.tsの終日4件経由の
// 間接検証のみで、その4件は既知不具合で赤)、排他的終了日→包含最終日変換という唯一のoff-by-oneガードが
// 実質ノーガードだった。ここではその変換点そのものをja/en双方で直接検証する。

describe('inclusiveEndDate', () => {
  it('subtracts one day within the same month', () => {
    expect(inclusiveEndDate('2026-08-06')).toBe('2026-08-05')
  })

  it('crosses a month boundary (1st of month -> last day of previous month)', () => {
    expect(inclusiveEndDate('2026-08-01')).toBe('2026-07-31')
  })

  it('crosses a year boundary (Jan 1 -> Dec 31 of previous year)', () => {
    expect(inclusiveEndDate('2027-01-01')).toBe('2026-12-31')
  })

  it('resolves Feb 29 on a leap year boundary (Mar 1 2028 -> Feb 29 2028)', () => {
    expect(inclusiveEndDate('2028-03-01')).toBe('2028-02-29')
  })

  it('resolves Feb 28 on a non-leap year boundary (Mar 1 2027 -> Feb 28 2027)', () => {
    expect(inclusiveEndDate('2027-03-01')).toBe('2027-02-28')
  })
})

describe('formatAllDayWhen (ja, default locale)', () => {
  it('formats a single day (startDate === inclusive end) without a range dash', () => {
    const text = formatAllDayWhen('2026-08-03', '2026-08-04')
    expect(text).toBe('終日 8/3')
    expect(text).not.toContain('8/4')
  })

  it('formats a multi-day range using the inclusive end date, never the exclusive end date', () => {
    const text = formatAllDayWhen('2026-08-03', '2026-08-06')
    expect(text).toBe('終日 8/3〜8/5')
    expect(text).not.toContain('8/6')
  })

  it('formats a range crossing a month boundary', () => {
    expect(formatAllDayWhen('2026-08-30', '2026-09-02')).toBe('終日 8/30〜9/1')
  })

  it('formats a range crossing a year boundary', () => {
    expect(formatAllDayWhen('2026-12-29', '2027-01-04')).toBe('終日 12/29〜1/3')
  })

  it('formats a range ending on a leap-year Feb 29', () => {
    expect(formatAllDayWhen('2028-02-28', '2028-03-01')).toBe('終日 2/28〜2/29')
  })

  it('treats endDateExclusive === null as a single day', () => {
    const text = formatAllDayWhen('2026-08-03', null)
    expect(text).toBe('終日 8/3')
  })
})

describe('formatAllDayWhen (en)', () => {
  beforeEach(() => setActiveLocale('en'))
  afterEach(() => resetActiveLocaleForTest())

  it('formats a single day without a range dash', () => {
    const text = formatAllDayWhen('2026-08-03', '2026-08-04')
    expect(text).toBe('All day, Aug 3')
    expect(text).not.toContain('Aug 4')
  })

  it('formats a multi-day range using the inclusive end date, never the exclusive end date', () => {
    const text = formatAllDayWhen('2026-08-03', '2026-08-06')
    expect(text).toBe('All day, Aug 3 - Aug 5')
    expect(text).not.toContain('Aug 6')
  })

  it('formats a range crossing a month boundary', () => {
    expect(formatAllDayWhen('2026-08-30', '2026-09-02')).toBe('All day, Aug 30 - Sep 1')
  })

  it('formats a range crossing a year boundary', () => {
    expect(formatAllDayWhen('2026-12-29', '2027-01-04')).toBe('All day, Dec 29 - Jan 3')
  })

  it('formats a range ending on a leap-year Feb 29', () => {
    expect(formatAllDayWhen('2028-02-28', '2028-03-01')).toBe('All day, Feb 28 - Feb 29')
  })

  it('treats endDateExclusive === null as a single day', () => {
    expect(formatAllDayWhen('2026-08-03', null)).toBe('All day, Aug 3')
  })

  it('never uses the full-width tilde or an en dash as a range separator', () => {
    const text = formatAllDayWhen('2026-08-03', '2026-08-06')
    expect(text).not.toContain('〜')
    expect(text).not.toContain('–')
  })
})

describe('isValidLocalDate', () => {
  it('accepts a well-formed YYYY-MM-DD string', () => {
    expect(isValidLocalDate('2026-08-03')).toBe(true)
  })

  it('rejects malformed strings', () => {
    expect(isValidLocalDate('2026/08/03')).toBe(false)
    expect(isValidLocalDate('not-a-date')).toBe(false)
    expect(isValidLocalDate('')).toBe(false)
  })
})
