import { describe, expect, it } from 'vitest';
import { parseInitialFragmentResult } from '../src/gemini/eventCandidateSchema.js';

function validPayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    resultType: 'event_candidate',
    title: '打ち合わせ',
    dateLocal: '2026-07-23',
    endDateLocal: null,
    startTimeLocal: '15:00:00',
    durationMinutes: 60,
    allDaySignal: null,
    timeZone: 'Asia/Tokyo',
    explicitCorrection: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions: [],
    ...overrides,
  };
}

describe('parseInitialFragmentResult', () => {
  it('accepts a well-formed event_candidate', () => {
    const parsed = parseInitialFragmentResult(validPayload());
    expect(parsed).not.toBeNull();
    expect(parsed?.resultType).toBe('event_candidate');
    expect(parsed?.dateLocal).toBe('2026-07-23');
    expect(parsed?.startTimeLocal).toBe('15:00:00');
    expect(parsed?.durationMinutes).toBe(60);
  });

  it('accepts a well-formed needs_clarification with a partial fragment (date known, time unknown)', () => {
    const parsed = parseInitialFragmentResult(
      validPayload({
        resultType: 'needs_clarification',
        startTimeLocal: null,
        durationMinutes: null,
        clarificationField: 'start_time',
        clarificationQuestion: '何時からですか?',
      }),
    );
    expect(parsed?.resultType).toBe('needs_clarification');
    // 日付は既知のまま(未確定を表すnullではない)ことを確認する。これが今回の実機不具合の直接の回帰確認。
    expect(parsed?.dateLocal).toBe('2026-07-23');
    expect(parsed?.startTimeLocal).toBeNull();
  });

  it('accepts a well-formed not_calendar_request', () => {
    const parsed = parseInitialFragmentResult(
      validPayload({ resultType: 'not_calendar_request', title: null, dateLocal: null, startTimeLocal: null, durationMinutes: null }),
    );
    expect(parsed?.resultType).toBe('not_calendar_request');
  });

  it('rejects resultType="cancelled" (not allowed for the initial route)', () => {
    expect(parseInitialFragmentResult(validPayload({ resultType: 'cancelled' }))).toBeNull();
  });

  it('rejects an invalid resultType enum value', () => {
    expect(parseInitialFragmentResult(validPayload({ resultType: 'something_else' }))).toBeNull();
  });

  it('rejects a wrong schemaVersion', () => {
    expect(parseInitialFragmentResult(validPayload({ schemaVersion: '2' }))).toBeNull();
  });

  it('rejects a wrong timeZone', () => {
    expect(parseInitialFragmentResult(validPayload({ timeZone: 'UTC' }))).toBeNull();
  });

  it('rejects a malformed dateLocal (not YYYY-MM-DD)', () => {
    expect(parseInitialFragmentResult(validPayload({ dateLocal: '2026/07/23' }))).toBeNull();
  });

  it('rejects a malformed startTimeLocal (not HH:mm:ss)', () => {
    expect(parseInitialFragmentResult(validPayload({ startTimeLocal: '3pm' }))).toBeNull();
  });

  it('rejects a non-integer durationMinutes', () => {
    expect(parseInitialFragmentResult(validPayload({ durationMinutes: 60.5 }))).toBeNull();
  });

  it('rejects an out-of-range durationMinutes', () => {
    expect(parseInitialFragmentResult(validPayload({ durationMinutes: 0 }))).toBeNull();
    expect(parseInitialFragmentResult(validPayload({ durationMinutes: 999999 }))).toBeNull();
  });

  it('rejects a missing explicitCorrection field', () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).explicitCorrection;
    expect(parseInitialFragmentResult(payload)).toBeNull();
  });

  it('accepts a null endDateLocal and an omitted endDateLocal key equally', () => {
    const withNull = parseInitialFragmentResult(validPayload({ endDateLocal: null }));
    const payloadWithoutKey = validPayload();
    delete (payloadWithoutKey as Record<string, unknown>).endDateLocal;
    const withoutKey = parseInitialFragmentResult(payloadWithoutKey);
    expect(withNull?.endDateLocal).toBeNull();
    expect(withoutKey?.endDateLocal).toBeNull();
  });

  it('accepts a well-formed endDateLocal for a multi-day all-day candidate', () => {
    const parsed = parseInitialFragmentResult(
      validPayload({ startTimeLocal: null, durationMinutes: null, endDateLocal: '2026-08-05', allDaySignal: 'all_day' }),
    );
    expect(parsed?.endDateLocal).toBe('2026-08-05');
    expect(parsed?.allDaySignal).toBe('all_day');
  });

  it('rejects a malformed endDateLocal (not YYYY-MM-DD)', () => {
    expect(parseInitialFragmentResult(validPayload({ endDateLocal: '2026/08/05' }))).toBeNull();
  });

  it('rejects an invalid allDaySignal enum value', () => {
    expect(parseInitialFragmentResult(validPayload({ allDaySignal: 'yes' }))).toBeNull();
  });

  it('rejects an invalid clarificationField enum value', () => {
    expect(parseInitialFragmentResult(validPayload({ clarificationField: 'invalid_field' }))).toBeNull();
  });

  it('rejects assumptions that are not an array of strings', () => {
    expect(parseInitialFragmentResult(validPayload({ assumptions: [1, 2] }))).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(parseInitialFragmentResult('not an object')).toBeNull();
    expect(parseInitialFragmentResult(null)).toBeNull();
    expect(parseInitialFragmentResult(undefined)).toBeNull();
  });

  it('rejects an oversized title (guards against runaway model output)', () => {
    expect(parseInitialFragmentResult(validPayload({ title: 'x'.repeat(201) }))).toBeNull();
  });

  it('does not expose any transcription-shaped field even if the model adds one', () => {
    const parsed = parseInitialFragmentResult(validPayload({ transcription: '発話全文...' }));
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('transcription');
  });
});
