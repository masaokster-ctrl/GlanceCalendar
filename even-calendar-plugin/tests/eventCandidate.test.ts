import { describe, expect, it } from 'vitest'
import {
  parseEventCandidateResult,
  validateEventCandidateTiming,
  parseLocalDateTime,
  nowLocalIsoTokyo,
  type EventCandidateResult,
} from '../src/eventCandidate'

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    resultType: 'event_candidate',
    title: '打ち合わせ',
    startLocal: '2026-07-23T15:00:00',
    endLocal: '2026-07-23T16:00:00',
    timeZone: 'Asia/Tokyo',
    allDay: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions: [],
    ...overrides,
  }
}

describe('parseEventCandidateResult', () => {
  it('accepts a well-formed event_candidate', () => {
    const result = parseEventCandidateResult(validPayload())
    expect(result).not.toBeNull()
    expect(result?.resultType).toBe('event_candidate')
  })

  it('accepts needs_clarification and not_calendar_request', () => {
    expect(
      parseEventCandidateResult(
        validPayload({ resultType: 'needs_clarification', title: null, startLocal: null, endLocal: null, clarificationField: 'date' }),
      )?.resultType,
    ).toBe('needs_clarification')
    expect(
      parseEventCandidateResult(validPayload({ resultType: 'not_calendar_request', title: null, startLocal: null, endLocal: null }))
        ?.resultType,
    ).toBe('not_calendar_request')
  })

  it('rejects an invalid resultType', () => {
    expect(parseEventCandidateResult(validPayload({ resultType: 'bogus' }))).toBeNull()
  })

  it('rejects a wrong schemaVersion or timeZone', () => {
    expect(parseEventCandidateResult(validPayload({ schemaVersion: '2' }))).toBeNull()
    expect(parseEventCandidateResult(validPayload({ timeZone: 'UTC' }))).toBeNull()
  })

  it('rejects a malformed startLocal/endLocal format', () => {
    expect(parseEventCandidateResult(validPayload({ startLocal: '2026/07/23 15:00' }))).toBeNull()
    expect(parseEventCandidateResult(validPayload({ endLocal: 'not-a-date' }))).toBeNull()
  })

  it('rejects a non-boolean allDay', () => {
    expect(parseEventCandidateResult(validPayload({ allDay: 'no' }))).toBeNull()
  })

  it('rejects an invalid clarificationField', () => {
    expect(parseEventCandidateResult(validPayload({ clarificationField: 'nope' }))).toBeNull()
  })

  it('rejects non-object / null / undefined payloads', () => {
    expect(parseEventCandidateResult(null)).toBeNull()
    expect(parseEventCandidateResult(undefined)).toBeNull()
    expect(parseEventCandidateResult('a string')).toBeNull()
    expect(parseEventCandidateResult(42)).toBeNull()
  })

  it('does not surface a transcription-shaped field even if present in the raw payload', () => {
    const result = parseEventCandidateResult(validPayload({ transcription: '発話全文' }))
    expect(result).not.toBeNull()
    expect(result).not.toHaveProperty('transcription')
  })
})

describe('validateEventCandidateTiming', () => {
  const NOW = '2026-07-22T10:00:00'

  function candidate(overrides: Partial<EventCandidateResult> = {}): EventCandidateResult {
    return {
      schemaVersion: '1',
      resultType: 'event_candidate',
      title: '打ち合わせ',
      startLocal: '2026-07-23T15:00:00',
      endLocal: '2026-07-23T16:00:00',
      timeZone: 'Asia/Tokyo',
      allDay: false,
      clarificationField: null,
      clarificationQuestion: null,
      assumptions: [],
      ...overrides,
    }
  }

  it('accepts a valid future event_candidate', () => {
    expect(validateEventCandidateTiming(candidate(), NOW)).toBe(true)
  })

  it('rejects a past-dated event_candidate', () => {
    expect(validateEventCandidateTiming(candidate({ startLocal: '2020-01-01T10:00:00', endLocal: '2020-01-01T11:00:00' }), NOW)).toBe(
      false,
    )
  })

  it('rejects endLocal <= startLocal', () => {
    expect(validateEventCandidateTiming(candidate({ endLocal: '2026-07-23T15:00:00' }), NOW)).toBe(false)
  })

  it('rejects missing startLocal/endLocal', () => {
    expect(validateEventCandidateTiming(candidate({ startLocal: null }), NOW)).toBe(false)
  })

  it('always accepts non-event_candidate result types regardless of dates', () => {
    expect(validateEventCandidateTiming(candidate({ resultType: 'needs_clarification', startLocal: null, endLocal: null }), NOW)).toBe(
      true,
    )
  })
})

describe('parseLocalDateTime', () => {
  it('parses a valid local datetime string', () => {
    expect(parseLocalDateTime('2026-07-23T15:04:05')).toEqual({ year: 2026, month: 7, day: 23, hour: 15, minute: 4, second: 5 })
  })

  it('returns null for malformed input', () => {
    expect(parseLocalDateTime('garbage')).toBeNull()
  })
})

describe('nowLocalIsoTokyo', () => {
  it('formats as YYYY-MM-DDTHH:mm:ss', () => {
    const text = nowLocalIsoTokyo(new Date('2026-01-01T00:00:00Z'))
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  })
})
