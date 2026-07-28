import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/time/clock.js';
import { createOAuthStateCookieValue, generateOAuthState, verifyOAuthState } from '../src/auth/oauthState.js';

const SECRET = 'setup-admin-token-secret';

describe('oauth state', () => {
  it('verifies when the cookie value and callback state match', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const state = generateOAuthState();
    const cookieValue = createOAuthStateCookieValue(SECRET, state, clock);
    expect(verifyOAuthState(SECRET, cookieValue, state, clock)).toBe(true);
  });

  it('rejects when the callback state does not match the cookie', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const state = generateOAuthState();
    const cookieValue = createOAuthStateCookieValue(SECRET, state, clock);
    const otherState = generateOAuthState();
    expect(verifyOAuthState(SECRET, cookieValue, otherState, clock)).toBe(false);
  });

  it('rejects when the cookie is missing', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const state = generateOAuthState();
    expect(verifyOAuthState(SECRET, undefined, state, clock)).toBe(false);
  });

  it('generates a sufficiently random, unique state value', () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});
