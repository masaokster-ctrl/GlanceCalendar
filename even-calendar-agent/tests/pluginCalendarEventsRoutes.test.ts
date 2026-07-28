import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';
import { InMemoryPluginSessionRepository, type PluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import {
  InMemoryPluginEventCandidateRepository,
  type PluginEventCandidateRepository,
} from '../src/firestore/pluginEventCandidateRepository.js';
import { FakeCalendarClient } from '../src/calendar/calendarClient.js';
import { createCalendarService, type CalendarService } from '../src/calendar/calendarService.js';
import { generateDevSessionToken, hashDevSessionToken, hashValue } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';

const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-07-22T05:00:00Z');

async function createSession(
  repo: PluginSessionRepository,
  overrides: { scope?: string[]; installId?: string; revoked?: boolean; expiresAt?: Date } = {},
): Promise<string> {
  const token = generateDevSessionToken();
  await repo.create({
    tokenHash: hashDevSessionToken(token),
    installId: overrides.installId ?? INSTALL_ID,
    scope: overrides.scope ?? ['audio:analyze', 'calendar:create', 'calendar:status'],
    now: NOW,
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 3_600_000),
  });
  if (overrides.revoked) {
    await repo.revoke(hashDevSessionToken(token), NOW);
  }
  return token;
}

async function createCandidate(
  repo: PluginEventCandidateRepository,
  token: string,
  overrides: Partial<Parameters<PluginEventCandidateRepository['create']>[0]> = {},
): Promise<void> {
  await repo.create({
    candidateId: CANDIDATE_ID,
    sessionHash: hashDevSessionToken(token),
    installIdHash: hashValue(INSTALL_ID),
    title: '打ち合わせ',
    startLocal: '2026-07-23T15:00:00',
    endLocal: '2026-07-23T16:00:00',
    timeZone: 'Asia/Tokyo',
    allDay: false,
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    analysisRequestIdHash: 'analysis-req-hash',
    ...overrides,
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    candidateId: CANDIDATE_ID,
    title: '打ち合わせ',
    startLocal: '2026-07-23T15:00:00',
    endLocal: '2026-07-23T16:00:00',
    timeZone: 'Asia/Tokyo',
    allDay: false,
    ...overrides,
  };
}

interface Setup {
  app: ReturnType<typeof createTestApp>;
  sessionRepo: PluginSessionRepository;
  candidateRepo: PluginEventCandidateRepository;
  calendarClient: FakeCalendarClient;
  token: string;
}

async function setup(
  sessionOverrides: Parameters<typeof createSession>[1] = {},
  resolveCalendarService?: () => Promise<CalendarService | null>,
): Promise<Setup> {
  const sessionRepo = new InMemoryPluginSessionRepository();
  const candidateRepo = new InMemoryPluginEventCandidateRepository();
  const calendarClient = new FakeCalendarClient();
  const token = await createSession(sessionRepo, sessionOverrides);
  await createCandidate(candidateRepo, token);
  const app = createTestApp({
    pluginSessionRepo: sessionRepo,
    pluginEventCandidateRepo: candidateRepo,
    resolveCalendarService: resolveCalendarService ?? (async () => createCalendarService(calendarClient)),
    clock: fixedClock(NOW),
  });
  return { app, sessionRepo, candidateRepo, calendarClient, token };
}

function postRegister(app: ReturnType<typeof createTestApp>, token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const req = request(app)
    .post('/plugin/calendar-events')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Install-Id', INSTALL_ID)
    .set('X-Request-Id', REQUEST_ID)
    .set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send(body);
}

describe('OPTIONS /plugin/calendar-events (CORS preflight)', () => {
  it('responds 204 with scoped CORS headers', async () => {
    const { app } = await setup();
    const res = await request(app).options('/plugin/calendar-events');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('POST /plugin/calendar-events success', () => {
  it('registers the event and returns candidateId+status only', async () => {
    const { app, token, calendarClient } = await setup();
    const res = await postRegister(app, token, validBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ candidateId: CANDIDATE_ID, status: 'completed' });
    expect(calendarClient.insertCallCount).toBe(1);
  });

  it('never returns title/date/googleEventId in the response body', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody());
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('打ち合わせ');
    expect(text).not.toContain('2026-07-23');
  });

  it('sets Cache-Control: no-store and X-Content-Type-Options: nosniff', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody());
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('POST /plugin/calendar-events authentication/authorization', () => {
  it('returns 401 when Authorization is missing', async () => {
    const { app } = await setup();
    const res = await request(app)
      .post('/plugin/calendar-events')
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID)
      .send(validBody());
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const { app } = await setup();
    const res = await postRegister(app, 'not-a-real-token', validBody());
    expect(res.status).toBe(401);
  });

  it('returns 401 for a revoked session', async () => {
    const { app, token } = await setup({ revoked: true });
    const res = await postRegister(app, token, validBody());
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired session', async () => {
    const { app, token } = await setup({ expiresAt: new Date(NOW.getTime() - 1000) });
    const res = await postRegister(app, token, validBody());
    expect(res.status).toBe(401);
  });

  it('returns 403 when scope does not include calendar:create', async () => {
    const { app, token } = await setup({ scope: ['audio:analyze', 'calendar:status'] });
    const res = await postRegister(app, token, validBody());
    expect(res.status).toBe(403);
  });

  it('returns 403 when X-Install-Id does not match the session', async () => {
    const { app, token } = await setup({ installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const res = await postRegister(app, token, validBody());
    expect(res.status).toBe(403);
  });
});

describe('POST /plugin/calendar-events candidate validation', () => {
  it('returns 410 for an unknown candidateId', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody({ candidateId: '99999999-9999-4999-8999-999999999999' }));
    expect(res.status).toBe(410);
  });

  it('returns 410 for an expired candidate', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await createCandidate(candidateRepo, token, { expiresAt: new Date(NOW.getTime() - 1000) });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginEventCandidateRepo: candidateRepo, clock: fixedClock(NOW) });
    const res = await postRegister(app, token, validBody());
    expect(res.status).toBe(410);
  });

  it('returns 403 when the candidate belongs to a different session', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    // candidateは別セッションのハッシュで作成する
    await candidateRepo.create({
      candidateId: CANDIDATE_ID,
      sessionHash: 'someone-elses-session-hash',
      installIdHash: hashValue(INSTALL_ID),
      title: '打ち合わせ',
      startLocal: '2026-07-23T15:00:00',
      endLocal: '2026-07-23T16:00:00',
      timeZone: 'Asia/Tokyo',
      allDay: false,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 600_000),
      analysisRequestIdHash: 'hash',
    });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginEventCandidateRepo: candidateRepo, clock: fixedClock(NOW) });
    const res = await postRegister(app, token, validBody());
    expect(res.status).toBe(403);
  });

  it('returns 400 when the request body does not match the stored candidate (tampered title)', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody({ title: 'DIFFERENT_TITLE' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a missing/malformed candidateId', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody({ candidateId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /plugin/calendar-events request body validation', () => {
  it('returns 400 for a title over 120 characters', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await createCandidate(candidateRepo, token, { title: 'x'.repeat(121) });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginEventCandidateRepo: candidateRepo, clock: fixedClock(NOW) });
    const res = await postRegister(app, token, validBody({ title: 'x'.repeat(121) }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for an empty title', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody({ title: '' }));
    expect(res.status).toBe(400);
  });

  it('returns 410 for a past startLocal (business rule re-validated at registration time)', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await createCandidate(candidateRepo, token, { startLocal: '2020-01-01T10:00:00', endLocal: '2020-01-01T11:00:00' });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginEventCandidateRepo: candidateRepo, clock: fixedClock(NOW) });
    const res = await postRegister(app, token, validBody({ startLocal: '2020-01-01T10:00:00', endLocal: '2020-01-01T11:00:00' }));
    expect(res.status).toBe(410);
  });

  it('returns 410 when endLocal <= startLocal', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await createCandidate(candidateRepo, token, { endLocal: '2026-07-23T15:00:00' });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginEventCandidateRepo: candidateRepo, clock: fixedClock(NOW) });
    const res = await postRegister(app, token, validBody({ endLocal: '2026-07-23T15:00:00' }));
    expect(res.status).toBe(410);
  });

  it('returns 410 for a duration over 24 hours', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await createCandidate(candidateRepo, token, { startLocal: '2026-07-23T00:00:00', endLocal: '2026-07-24T01:00:00' });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginEventCandidateRepo: candidateRepo, clock: fixedClock(NOW) });
    const res = await postRegister(app, token, validBody({ startLocal: '2026-07-23T00:00:00', endLocal: '2026-07-24T01:00:00' }));
    expect(res.status).toBe(410);
  });

  it('returns 410 for a start date more than 365 days in the future', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await createCandidate(candidateRepo, token, { startLocal: '2028-01-01T10:00:00', endLocal: '2028-01-01T11:00:00' });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginEventCandidateRepo: candidateRepo, clock: fixedClock(NOW) });
    const res = await postRegister(app, token, validBody({ startLocal: '2028-01-01T10:00:00', endLocal: '2028-01-01T11:00:00' }));
    expect(res.status).toBe(410);
  });

  it('returns 400 for a timeZone other than Asia/Tokyo', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody({ timeZone: 'UTC' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for allDay=true when startLocal/endLocal are still present (field-set must not mix)', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody({ allDay: true }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid request body');
  });

  it('returns 400 for allDay=true missing startDate/endDateExclusive', async () => {
    const { app, token } = await setup();
    const res = await postRegister(
      app,
      token,
      validBody({ allDay: true, startLocal: undefined, endLocal: undefined }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid request body');
  });

  it('returns 400 for allDay=true when startDate >= endDateExclusive', async () => {
    const { app, token } = await setup();
    const res = await postRegister(
      app,
      token,
      validBody({
        allDay: true,
        startLocal: undefined,
        endLocal: undefined,
        startDate: '2026-07-25',
        endDateExclusive: '2026-07-25',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid request body');
  });

  it('accepts allDay=true shape (startLocal/endLocal null, startDate/endDateExclusive well-formed) past body-shape validation', async () => {
    // stored candidate title differs on purpose: proves the request passed isValidBodyShape and only
    // failed later at the stored-candidate comparison, not at shape validation.
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await candidateRepo.create({
      candidateId: CANDIDATE_ID,
      sessionHash: hashDevSessionToken(token),
      installIdHash: hashValue(INSTALL_ID),
      title: 'DIFFERENT_TITLE',
      startLocal: null,
      endLocal: null,
      timeZone: 'Asia/Tokyo',
      allDay: true,
      startDate: '2026-07-23',
      endDateExclusive: '2026-07-25',
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 600_000),
      analysisRequestIdHash: 'hash',
    });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginEventCandidateRepo: candidateRepo, clock: fixedClock(NOW) });
    const res = await postRegister(
      app,
      token,
      validBody({
        allDay: true,
        startLocal: undefined,
        endLocal: undefined,
        startDate: '2026-07-23',
        endDateExclusive: '2026-07-25',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Request body does not match the stored candidate');
  });

  it('returns 400 when allDay=true and startDate/endDateExclusive do not match the stored all-day candidate', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await candidateRepo.create({
      candidateId: CANDIDATE_ID,
      sessionHash: hashDevSessionToken(token),
      installIdHash: hashValue(INSTALL_ID),
      title: '打ち合わせ',
      startLocal: null,
      endLocal: null,
      timeZone: 'Asia/Tokyo',
      allDay: true,
      startDate: '2026-07-23',
      endDateExclusive: '2026-07-25',
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 600_000),
      analysisRequestIdHash: 'hash',
    });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginEventCandidateRepo: candidateRepo, clock: fixedClock(NOW) });
    const res = await postRegister(
      app,
      token,
      validBody({
        allDay: true,
        startLocal: undefined,
        endLocal: undefined,
        startDate: '2026-07-23',
        endDateExclusive: '2026-07-26',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Request body does not match the stored candidate');
  });

  it('does not call Calendar insert when validation fails', async () => {
    const { app, token, calendarClient } = await setup();
    await postRegister(app, token, validBody({ allDay: true }));
    await postRegister(app, token, validBody({ timeZone: 'UTC' }));
    await postRegister(app, token, validBody({ title: '' }));
    expect(calendarClient.insertCallCount).toBe(0);
  });
});

describe('POST /plugin/calendar-events legacy allDay-omitted body (pre-0.2.2 backward compatibility)', () => {
  it('accepts a legacy body with allDay omitted and valid startLocal/endLocal as a normal (non-all-day) event', async () => {
    const { app, token, calendarClient } = await setup();
    const res = await postRegister(app, token, validBody({ allDay: undefined }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ candidateId: CANDIDATE_ID, status: 'completed' });
    expect(calendarClient.insertCallCount).toBe(1);
  });

  it('rejects a legacy body with allDay omitted but startDate/endDateExclusive present (no mixing with all-day fields)', async () => {
    const { app, token } = await setup();
    const res = await postRegister(
      app,
      token,
      validBody({ allDay: undefined, startDate: '2026-07-23', endDateExclusive: '2026-07-25' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid request body');
  });

  it('rejects a legacy body with allDay omitted and endLocal missing', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody({ allDay: undefined, endLocal: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid request body');
  });

  it('rejects a legacy body with allDay omitted and both startLocal/endLocal missing', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody({ allDay: undefined, startLocal: undefined, endLocal: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid request body');
  });

  it('rejects a legacy allDay-omitted body whose normalized fields do not match the stored candidate', async () => {
    const { app, token } = await setup();
    const res = await postRegister(app, token, validBody({ allDay: undefined, title: 'DIFFERENT_TITLE' }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Request body does not match the stored candidate');
  });
});

describe('POST /plugin/calendar-events idempotency and concurrency', () => {
  it('returns 409 when a concurrent request already holds the lease', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await createCandidate(candidateRepo, token);
    await candidateRepo.acquireLease({ candidateId: CANDIDATE_ID, leaseOwner: 'other-owner', leaseDurationMs: 30_000, now: NOW });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginEventCandidateRepo: candidateRepo, clock: fixedClock(NOW) });

    const res = await postRegister(app, token, validBody());
    expect(res.status).toBe(409);
  });

  it('a second concurrent double-request only inserts into Calendar once', async () => {
    const { app, token, calendarClient } = await setup();
    const [res1, res2] = await Promise.all([postRegister(app, token, validBody()), postRegister(app, token, validBody())]);
    const statuses = [res1.status, res2.status].sort();
    // 片方は200(成功)、もう片方は409(lease中)または200(lease解放後に取得しsuccessになる可能性)のいずれか
    expect(statuses[0]).toBeGreaterThanOrEqual(200);
    expect(calendarClient.insertCallCount).toBeLessThanOrEqual(1);
  });

  it('returns 200/completed for a retried request after the first attempt already succeeded (idempotent replay, no new insert)', async () => {
    const { app, token, calendarClient } = await setup();
    const first = await postRegister(app, token, validBody());
    expect(first.status).toBe(200);
    const second = await postRegister(app, token, validBody());
    expect(second.status).toBe(200);
    expect(calendarClient.insertCallCount).toBe(1);
  });
});

describe('POST /plugin/calendar-events Calendar/OAuth failure handling', () => {
  it('returns 503 when OAuth is not connected', async () => {
    const { app, token } = await setup({}, async () => null);
    const res = await postRegister(app, token, validBody());
    expect(res.status).toBe(503);
  });

  it('returns 502 when the Calendar API throws a non-recoverable error', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await createCandidate(candidateRepo, token);
    const client = new FakeCalendarClient();
    client.nextInsertError = () => {
      throw Object.assign(new Error('server error'), { code: 500 });
    };
    const app = createTestApp({
      pluginSessionRepo: sessionRepo,
      pluginEventCandidateRepo: candidateRepo,
      resolveCalendarService: async () => createCalendarService(client),
      clock: fixedClock(NOW),
    });
    const res = await postRegister(app, token, validBody());
    expect(res.status).toBe(502);
  });

  it('does not expose the raw Calendar error or google event body in the response', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const token = await createSession(sessionRepo);
    await createCandidate(candidateRepo, token);
    const client = new FakeCalendarClient();
    client.nextInsertError = () => {
      throw Object.assign(new Error('SENSITIVE_INTERNAL_DETAIL'), { code: 500 });
    };
    const app = createTestApp({
      pluginSessionRepo: sessionRepo,
      pluginEventCandidateRepo: candidateRepo,
      resolveCalendarService: async () => createCalendarService(client),
      clock: fixedClock(NOW),
    });
    const res = await postRegister(app, token, validBody());
    expect(JSON.stringify(res.body)).not.toContain('SENSITIVE_INTERNAL_DETAIL');
  });
});

describe('POST /plugin/calendar-events privacy: no sensitive logs', () => {
  it('never logs title, date/time, or googleEventId raw value', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, token } = await setup();
    await postRegister(app, token, validBody());
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain('打ち合わせ');
    expect(allLogText).not.toContain('2026-07-23');
    expect(allLogText).not.toContain(token);
    logSpy.mockRestore();
  });
});

describe('GET /plugin/calendar-events/status', () => {
  it('returns the current candidate status', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .get(`/plugin/calendar-events/status?candidateId=${CANDIDATE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ candidateId: CANDIDATE_ID, status: 'pending' });
  });

  it('reflects completed status after a successful registration', async () => {
    const { app, token } = await setup();
    await postRegister(app, token, validBody());
    const res = await request(app)
      .get(`/plugin/calendar-events/status?candidateId=${CANDIDATE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID);
    expect(res.body).toEqual({ candidateId: CANDIDATE_ID, status: 'completed' });
  });

  it('never returns title, date/time, or googleEventId', async () => {
    const { app, token } = await setup();
    await postRegister(app, token, validBody());
    const res = await request(app)
      .get(`/plugin/calendar-events/status?candidateId=${CANDIDATE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID);
    expect(Object.keys(res.body).sort()).toEqual(['candidateId', 'status']);
  });

  it('returns expired for an unknown candidateId (does not leak not-found vs expired distinction)', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .get(`/plugin/calendar-events/status?candidateId=99999999-9999-4999-8999-999999999999`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('expired');
  });

  it('returns 401 without a valid session token', async () => {
    const { app } = await setup();
    const res = await request(app).get(`/plugin/calendar-events/status?candidateId=${CANDIDATE_ID}`).set('X-Install-Id', INSTALL_ID);
    expect(res.status).toBe(401);
  });

  it('returns 403 when scope does not include calendar:status', async () => {
    const { app, token } = await setup({ scope: ['audio:analyze', 'calendar:create'] });
    const res = await request(app)
      .get(`/plugin/calendar-events/status?candidateId=${CANDIDATE_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID);
    expect(res.status).toBe(403);
  });

  it('preflight OPTIONS on status route responds 204 with scoped CORS', async () => {
    const { app } = await setup();
    const res = await request(app).options('/plugin/calendar-events/status');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });
});
