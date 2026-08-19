import { describe, expect, it } from 'vitest'
import { initialPairingContext, pairingReducer } from '../../src/product/pairingState'

const EXPIRES_AT = Date.now() + 600_000

describe('pairingReducer', () => {
  it('starts idle', () => {
    expect(initialPairingContext.state).toBe('idle')
  })

  it('START -> starting', () => {
    const ctx = pairingReducer(initialPairingContext, { type: 'START' })
    expect(ctx.state).toBe('starting')
  })

  it('STARTED -> waitingApproval with pairing details populated (no verificationUrl field; expiresAt is an absolute timestamp)', () => {
    const ctx = pairingReducer(initialPairingContext, {
      type: 'STARTED',
      pairingId: 'p-1',
      userCode: 'ABCD-EFGH',
      pollIntervalSeconds: 3,
      expiresAt: EXPIRES_AT,
    })
    expect(ctx).toEqual({
      state: 'waitingApproval',
      pairingId: 'p-1',
      userCode: 'ABCD-EFGH',
      pollIntervalSeconds: 3,
      expiresAt: EXPIRES_AT,
      errorKind: null,
    })
  })

  it('RESTORED -> waitingApproval, identical shape to STARTED (used for BOOT-time resume from pairingResumeStore)', () => {
    const ctx = pairingReducer(initialPairingContext, {
      type: 'RESTORED',
      pairingId: 'p-1',
      userCode: 'ABCD-EFGH',
      pollIntervalSeconds: 3,
      expiresAt: EXPIRES_AT,
    })
    expect(ctx).toEqual({
      state: 'waitingApproval',
      pairingId: 'p-1',
      userCode: 'ABCD-EFGH',
      pollIntervalSeconds: 3,
      expiresAt: EXPIRES_AT,
      errorKind: null,
    })
  })

  it('START_FAILED -> error(communication_failure)', () => {
    const ctx = pairingReducer(initialPairingContext, { type: 'START_FAILED' })
    expect(ctx.state).toBe('error')
    expect(ctx.errorKind).toBe('communication_failure')
  })

  it('APPROVED -> exchanging (preserving pairing details)', () => {
    const started = pairingReducer(initialPairingContext, {
      type: 'STARTED',
      pairingId: 'p-1',
      userCode: 'code',
      pollIntervalSeconds: 3,
      expiresAt: EXPIRES_AT,
    })
    const ctx = pairingReducer(started, { type: 'APPROVED' })
    expect(ctx.state).toBe('exchanging')
    expect(ctx.pairingId).toBe('p-1')
  })

  it('EXCHANGE_SUCCEEDED -> success', () => {
    const ctx = pairingReducer({ ...initialPairingContext, state: 'exchanging' }, { type: 'EXCHANGE_SUCCEEDED' })
    expect(ctx.state).toBe('success')
  })

  it('EXPIRED -> error(expired)', () => {
    const ctx = pairingReducer(initialPairingContext, { type: 'EXPIRED' })
    expect(ctx.state).toBe('error')
    expect(ctx.errorKind).toBe('expired')
  })

  it('CANCELLED -> error(cancelled)', () => {
    const ctx = pairingReducer(initialPairingContext, { type: 'CANCELLED' })
    expect(ctx.errorKind).toBe('cancelled')
  })

  it('AUTH_FAILED -> error(auth_failure)', () => {
    const ctx = pairingReducer(initialPairingContext, { type: 'AUTH_FAILED' })
    expect(ctx.errorKind).toBe('auth_failure')
  })

  it('COMMUNICATION_FAILED -> error(communication_failure)', () => {
    const ctx = pairingReducer(initialPairingContext, { type: 'COMMUNICATION_FAILED' })
    expect(ctx.errorKind).toBe('communication_failure')
  })

  it('RESET returns to the initial context from any state', () => {
    const started = pairingReducer(initialPairingContext, {
      type: 'STARTED',
      pairingId: 'p-1',
      userCode: 'code',
      pollIntervalSeconds: 3,
      expiresAt: EXPIRES_AT,
    })
    expect(pairingReducer(started, { type: 'RESET' })).toEqual(initialPairingContext)
  })
})
