import { describe, expect, it } from 'vitest';
import { computeOperationId, computeGoogleEventId } from '../src/calendar/calendarEventId.js';

const BASE_INPUT = {
  userId: 'single-user',
  calendarId: 'primary',
  summary: '接続テスト予定',
  startDateTime: '2026-07-22T15:00:00+09:00',
  endDateTime: '2026-07-22T16:00:00+09:00',
  timeZone: 'Asia/Tokyo',
};

describe('computeOperationId', () => {
  it('is deterministic for identical event content', () => {
    expect(computeOperationId(BASE_INPUT)).toBe(computeOperationId({ ...BASE_INPUT }));
  });

  it('changes when the start time differs', () => {
    const other = { ...BASE_INPUT, startDateTime: '2026-07-22T16:00:00+09:00' };
    expect(computeOperationId(BASE_INPUT)).not.toBe(computeOperationId(other));
  });

  it('changes when the title differs', () => {
    const other = { ...BASE_INPUT, summary: '別の予定' };
    expect(computeOperationId(BASE_INPUT)).not.toBe(computeOperationId(other));
  });

  it('changes when the end time, calendar, or time zone differs', () => {
    const id = computeOperationId(BASE_INPUT);
    expect(computeOperationId({ ...BASE_INPUT, endDateTime: '2026-07-22T17:00:00+09:00' })).not.toBe(id);
    expect(computeOperationId({ ...BASE_INPUT, calendarId: 'work' })).not.toBe(id);
    expect(computeOperationId({ ...BASE_INPUT, timeZone: 'UTC' })).not.toBe(id);
  });

  it('does not include a Bearer token in its hash source (input has no such field)', () => {
    // OperationIdInput型自体にBearer Token用のフィールドが存在しないことを型レベルで保証しているが、
    // 念のため出力にトークンらしき文字列が含まれないことも確認する。
    const id = computeOperationId(BASE_INPUT);
    expect(id).not.toContain('Bearer');
  });
});

describe('computeGoogleEventId', () => {
  it('is deterministic for the same operationId', () => {
    const operationId = computeOperationId(BASE_INPUT);
    expect(computeGoogleEventId(operationId)).toBe(computeGoogleEventId(operationId));
  });

  it('conforms to Google Calendar event ID format requirements (base32hex chars 0-9a-v, length 5-1024)', () => {
    const operationId = computeOperationId(BASE_INPUT);
    const eventId = computeGoogleEventId(operationId);

    expect(eventId).toMatch(/^[0-9a-v]+$/);
    expect(eventId.length).toBeGreaterThanOrEqual(5);
    expect(eventId.length).toBeLessThanOrEqual(1024);
  });

  it('differs from the operationId itself (separate hash)', () => {
    const operationId = computeOperationId(BASE_INPUT);
    expect(computeGoogleEventId(operationId)).not.toBe(operationId);
  });
});
