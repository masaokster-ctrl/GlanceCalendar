import { describe, expect, it } from 'vitest';
import { parseFollowupFragmentResult, FOLLOWUP_RESULT_RESPONSE_SCHEMA } from '../src/gemini/followupResultSchema.js';
import { ALL_DAY_SIGNAL_SCHEMA_DESCRIPTION } from '../src/gemini/allDayVocabulary.js';

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    resultType: 'event_candidate',
    title: '打ち合わせ',
    dateLocal: '2026-07-23',
    startTimeLocal: '15:00:00',
    durationMinutes: 60,
    timeZone: 'Asia/Tokyo',
    allDay: false,
    explicitCorrection: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions: [],
    ...overrides,
  };
}

describe('parseFollowupFragmentResult', () => {
  it('accepts event_candidate/needs_clarification/cancelled/not_calendar_request', () => {
    expect(parseFollowupFragmentResult(validPayload())?.resultType).toBe('event_candidate');
    expect(
      parseFollowupFragmentResult(
        validPayload({ resultType: 'needs_clarification', title: null, dateLocal: null, startTimeLocal: null, durationMinutes: null }),
      )?.resultType,
    ).toBe('needs_clarification');
    expect(
      parseFollowupFragmentResult(
        validPayload({ resultType: 'cancelled', title: null, dateLocal: null, startTimeLocal: null, durationMinutes: null }),
      )?.resultType,
    ).toBe('cancelled');
    expect(
      parseFollowupFragmentResult(
        validPayload({ resultType: 'not_calendar_request', title: null, dateLocal: null, startTimeLocal: null, durationMinutes: null }),
      )?.resultType,
    ).toBe('not_calendar_request');
  });

  it('rejects an invalid resultType', () => {
    expect(parseFollowupFragmentResult(validPayload({ resultType: 'bogus' }))).toBeNull();
  });

  it('accepts explicitCorrection=true', () => {
    expect(parseFollowupFragmentResult(validPayload({ explicitCorrection: true }))?.explicitCorrection).toBe(true);
  });

  it('rejects a missing explicitCorrection field', () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).explicitCorrection;
    expect(parseFollowupFragmentResult(payload)).toBeNull();
  });

  it('rejects malformed date/time formats', () => {
    expect(parseFollowupFragmentResult(validPayload({ dateLocal: '2026/07/23' }))).toBeNull();
    expect(parseFollowupFragmentResult(validPayload({ startTimeLocal: '15:00' }))).toBeNull();
  });

  it('rejects non-object payloads', () => {
    expect(parseFollowupFragmentResult(null)).toBeNull();
    expect(parseFollowupFragmentResult('x')).toBeNull();
  });

  it('does not surface a transcription-shaped field', () => {
    const result = parseFollowupFragmentResult(validPayload({ transcription: 'something' }));
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('transcription');
  });
});

describe('FOLLOWUP_RESULT_RESPONSE_SCHEMA: allDaySignal語彙の集約(設計§3.5)', () => {
  it('allDaySignal.descriptionは共有定数ALL_DAY_SIGNAL_SCHEMA_DESCRIPTIONと同一', () => {
    const props = FOLLOWUP_RESULT_RESPONSE_SCHEMA.properties as Record<string, { description?: string }>;
    expect(props.allDaySignal?.description).toBe(ALL_DAY_SIGNAL_SCHEMA_DESCRIPTION);
  });
});
