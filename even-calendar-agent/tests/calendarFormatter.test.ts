import { describe, expect, it } from 'vitest';
import { formatEventListForSpeech } from '../src/calendar/calendarFormatter.js';
import type { CalendarEventSummary } from '../src/calendar/calendarClient.js';

function timed(hour: number, minute: number, summary: string | null): CalendarEventSummary {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return {
    eventId: `id-${hour}-${minute}`,
    summary,
    startDateTime: `2026-07-21T${hh}:${mm}:00+09:00`,
    startDate: null,
    status: 'confirmed',
  };
}

function allDay(summary: string | null): CalendarEventSummary {
  return { eventId: 'all-day', summary, startDateTime: null, startDate: '2026-07-21', status: 'confirmed' };
}

describe('formatEventListForSpeech', () => {
  it('formats timed events in order with omitted minutes when zero', () => {
    const result = formatEventListForSpeech([timed(15, 0, '接続テスト予定')], 'なし');
    expect(result).toBe('15時 接続テスト予定');
  });

  it('formats timed events with minutes when non-zero', () => {
    const result = formatEventListForSpeech([timed(9, 30, '朝会')], 'なし');
    expect(result).toBe('9時30分 朝会');
  });

  it('formats all-day events', () => {
    const result = formatEventListForSpeech([allDay('会社休業日')], 'なし');
    expect(result).toBe('終日 会社休業日');
  });

  it('uses タイトルなし for empty or missing titles', () => {
    expect(formatEventListForSpeech([timed(10, 0, '')], 'なし')).toBe('10時 タイトルなし');
    expect(formatEventListForSpeech([timed(10, 0, null)], 'なし')).toBe('10時 タイトルなし');
  });

  it('returns the empty message when there are no events', () => {
    expect(formatEventListForSpeech([], '今日の予定はありません。')).toBe('今日の予定はありません。');
  });

  it('limits the number of displayed items and appends a remaining count', () => {
    const events = Array.from({ length: 8 }, (_, i) => timed(9 + i, 0, `予定${i + 1}`));
    const result = formatEventListForSpeech(events, 'なし');
    const lines = result.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('ほか3件あります');
  });

  it('excludes cancelled events', () => {
    const events = [timed(9, 0, '有効な予定'), { ...timed(10, 0, 'キャンセル済み'), status: 'cancelled' }];
    const result = formatEventListForSpeech(events, 'なし');
    expect(result).toBe('9時 有効な予定');
  });

  it('returns the empty message when all events are cancelled', () => {
    const events = [{ ...timed(9, 0, 'キャンセル済み'), status: 'cancelled' }];
    expect(formatEventListForSpeech(events, '今日の予定はありません。')).toBe('今日の予定はありません。');
  });
});
