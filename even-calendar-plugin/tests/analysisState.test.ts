import { describe, expect, it } from 'vitest'
import { analysisReducer, initialAnalysisContext } from '../src/analysisState'
import type { EventCandidateResult } from '../src/eventCandidate'

const RESULT: EventCandidateResult = {
  schemaVersion: '1',
  resultType: 'event_candidate',
  title: 't',
  startLocal: '2026-07-23T15:00:00',
  endLocal: '2026-07-23T16:00:00',
  timeZone: 'Asia/Tokyo',
  allDay: false,
  clarificationField: null,
  clarificationQuestion: null,
  assumptions: [],
}

describe('analysisReducer', () => {
  it('starts at idle', () => {
    expect(initialAnalysisContext.state).toBe('idle')
  })

  it('START moves to analyzing and clears prior result/error', () => {
    const ctx = analysisReducer({ state: 'error', result: null, errorCode: 'analysis_failed' }, { type: 'START' })
    expect(ctx).toEqual({ state: 'analyzing', result: null, errorCode: null })
  })

  it('SUCCEEDED moves to succeeded and carries the result', () => {
    const ctx = analysisReducer(initialAnalysisContext, { type: 'SUCCEEDED', result: RESULT })
    expect(ctx.state).toBe('succeeded')
    expect(ctx.result).toEqual(RESULT)
  })

  it('FAILED moves to error and carries the errorCode', () => {
    const ctx = analysisReducer(initialAnalysisContext, { type: 'FAILED', errorCode: 'analysis_timeout' })
    expect(ctx).toEqual({ state: 'error', result: null, errorCode: 'analysis_timeout' })
  })

  it('CANCELLED moves to cancelled', () => {
    const ctx = analysisReducer(initialAnalysisContext, { type: 'CANCELLED' })
    expect(ctx.state).toBe('cancelled')
  })

  it('RESET always returns to idle regardless of prior state', () => {
    const ctx = analysisReducer({ state: 'succeeded', result: RESULT, errorCode: null }, { type: 'RESET' })
    expect(ctx).toEqual(initialAnalysisContext)
  })
})
