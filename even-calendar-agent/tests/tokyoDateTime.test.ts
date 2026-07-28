import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/time/clock.js';
import {
  todayRangeTokyo,
  tomorrowRangeTokyo,
  tomorrowFixedEventRangeTokyo,
  toRfc3339,
  TOKYO_ZONE,
} from '../src/time/tokyoDateTime.js';

describe('todayRangeTokyo', () => {
  it('returns Asia/Tokyo 00:00 today through 00:00 tomorrow', () => {
    // 2026-07-21T01:00:00Z = 2026-07-21 10:00 JST
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const { start, end } = todayRangeTokyo(clock);

    expect(start.zoneName).toBe(TOKYO_ZONE);
    expect(start.toFormat('yyyy-MM-dd HH:mm:ss')).toBe('2026-07-21 00:00:00');
    expect(end.toFormat('yyyy-MM-dd HH:mm:ss')).toBe('2026-07-22 00:00:00');
  });

  it('handles a time just before local midnight correctly', () => {
    // 2026-07-21T14:59:00Z = 2026-07-21 23:59 JST
    const clock = fixedClock('2026-07-21T14:59:00.000Z');
    const { start, end } = todayRangeTokyo(clock);
    expect(start.toFormat('yyyy-MM-dd')).toBe('2026-07-21');
    expect(end.toFormat('yyyy-MM-dd')).toBe('2026-07-22');
  });
});

describe('tomorrowRangeTokyo', () => {
  it('returns Asia/Tokyo 00:00 tomorrow through 00:00 the day after', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const { start, end } = tomorrowRangeTokyo(clock);
    expect(start.toFormat('yyyy-MM-dd HH:mm:ss')).toBe('2026-07-22 00:00:00');
    expect(end.toFormat('yyyy-MM-dd HH:mm:ss')).toBe('2026-07-23 00:00:00');
  });

  it('rolls over correctly at month end', () => {
    // 2026-07-31 10:00 JST
    const clock = fixedClock('2026-07-31T01:00:00.000Z');
    const { start, end } = tomorrowRangeTokyo(clock);
    expect(start.toFormat('yyyy-MM-dd')).toBe('2026-08-01');
    expect(end.toFormat('yyyy-MM-dd')).toBe('2026-08-02');
  });

  it('rolls over correctly at year end', () => {
    // 2026-12-31 10:00 JST
    const clock = fixedClock('2026-12-31T01:00:00.000Z');
    const { start, end } = tomorrowRangeTokyo(clock);
    expect(start.toFormat('yyyy-MM-dd')).toBe('2027-01-01');
    expect(end.toFormat('yyyy-MM-dd')).toBe('2027-01-02');
  });
});

describe('tomorrowFixedEventRangeTokyo', () => {
  it('generates tomorrow 15:00-16:00 JST from a fixed clock', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const { start, end } = tomorrowFixedEventRangeTokyo(clock);
    expect(start.toFormat('yyyy-MM-dd HH:mm:ss')).toBe('2026-07-22 15:00:00');
    expect(end.toFormat('yyyy-MM-dd HH:mm:ss')).toBe('2026-07-22 16:00:00');
  });

  it('does not depend on the real current time', () => {
    const clockA = fixedClock('2020-01-01T00:00:00.000Z');
    const clockB = fixedClock('2020-01-01T00:00:00.000Z');
    const a = tomorrowFixedEventRangeTokyo(clockA);
    const b = tomorrowFixedEventRangeTokyo(clockB);
    expect(a.start.toISO()).toBe(b.start.toISO());
  });
});

describe('toRfc3339', () => {
  it('produces an RFC3339 string with the Asia/Tokyo offset', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const { start } = tomorrowFixedEventRangeTokyo(clock);
    const rfc = toRfc3339(start);
    expect(rfc).toMatch(/^2026-07-22T15:00:00\+09:00$/);
  });
});
