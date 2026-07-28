import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/time/clock.js';
import { createSetupSessionValue, isValidSetupSession, SESSION_TTL_MS } from '../src/auth/setupSession.js';

const SECRET = 'setup-admin-token-secret';

describe('setup session', () => {
  it('accepts a freshly created session value', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const value = createSetupSessionValue(SECRET, clock);
    expect(isValidSetupSession(SECRET, value, clock)).toBe(true);
  });

  it('rejects a session value signed with a different secret', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const value = createSetupSessionValue(SECRET, clock);
    expect(isValidSetupSession('wrong-secret', value, clock)).toBe(false);
  });

  it('rejects a missing or empty cookie value', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    expect(isValidSetupSession(SECRET, undefined, clock)).toBe(false);
    expect(isValidSetupSession(SECRET, '', clock)).toBe(false);
  });

  it('expires after the 30 minute TTL', () => {
    const startClock = fixedClock('2026-07-21T01:00:00.000Z');
    const value = createSetupSessionValue(SECRET, startClock);

    const justBeforeExpiry = fixedClock(new Date(Date.parse('2026-07-21T01:00:00.000Z') + SESSION_TTL_MS - 1000));
    expect(isValidSetupSession(SECRET, value, justBeforeExpiry)).toBe(true);

    const afterExpiry = fixedClock(new Date(Date.parse('2026-07-21T01:00:00.000Z') + SESSION_TTL_MS + 1000));
    expect(isValidSetupSession(SECRET, value, afterExpiry)).toBe(false);
  });

  it('never embeds the admin token secret itself in the session value', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const value = createSetupSessionValue(SECRET, clock);
    expect(value).not.toContain(SECRET);
  });
});
