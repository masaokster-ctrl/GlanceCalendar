import { describe, expect, it } from 'vitest'
import { recordingReducer, initialRecordingContext } from '../src/recordingState'

describe('recordingReducer (state machine)', () => {
  it('starts at idle', () => {
    expect(initialRecordingContext.state).toBe('idle')
  })

  it('idle -> starting -> recording on START then STARTED', () => {
    let ctx = recordingReducer(initialRecordingContext, { type: 'START' })
    expect(ctx.state).toBe('starting')
    ctx = recordingReducer(ctx, { type: 'STARTED' })
    expect(ctx.state).toBe('recording')
  })

  it('starting -> error on START_FAILED with the given error code', () => {
    const ctx = recordingReducer({ state: 'starting', durationSec: null, errorCode: null }, {
      type: 'START_FAILED',
      errorCode: 'audio_start_failed',
    })
    expect(ctx.state).toBe('error')
    expect(ctx.errorCode).toBe('audio_start_failed')
  })

  it('recording -> stopping -> captured on STOP then STOPPED with duration', () => {
    let ctx = recordingReducer({ state: 'recording', durationSec: null, errorCode: null }, { type: 'STOP' })
    expect(ctx.state).toBe('stopping')
    ctx = recordingReducer(ctx, { type: 'STOPPED', durationSec: 2.5 })
    expect(ctx.state).toBe('captured')
    expect(ctx.durationSec).toBe(2.5)
  })

  it('stopping -> error on STOP_FAILED', () => {
    const ctx = recordingReducer({ state: 'stopping', durationSec: null, errorCode: null }, {
      type: 'STOP_FAILED',
      errorCode: 'audio_stop_failed',
    })
    expect(ctx.state).toBe('error')
    expect(ctx.errorCode).toBe('audio_stop_failed')
  })

  it('recording -> stopping -> cancelled on CANCEL then CANCELLED', () => {
    let ctx = recordingReducer({ state: 'recording', durationSec: null, errorCode: null }, { type: 'CANCEL' })
    expect(ctx.state).toBe('stopping')
    ctx = recordingReducer(ctx, { type: 'CANCELLED' })
    expect(ctx.state).toBe('cancelled')
  })

  it('RESET always returns to idle with no residual data', () => {
    const ctx = recordingReducer({ state: 'error', durationSec: null, errorCode: 'unknown' }, { type: 'RESET' })
    expect(ctx).toEqual({ state: 'idle', durationSec: null, errorCode: null })
  })

  it('ERROR sets state to error with the given code from any state', () => {
    const ctx = recordingReducer({ state: 'recording', durationSec: null, errorCode: null }, {
      type: 'ERROR',
      errorCode: 'audio_event_timeout',
    })
    expect(ctx.state).toBe('error')
    expect(ctx.errorCode).toBe('audio_event_timeout')
  })

  it('is a pure function (does not mutate the input context)', () => {
    const input = { state: 'idle' as const, durationSec: null, errorCode: null }
    const frozen = Object.freeze({ ...input })
    expect(() => recordingReducer(frozen, { type: 'START' })).not.toThrow()
  })
})
