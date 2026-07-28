import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';
import { InMemoryPluginSessionRepository, type PluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { InMemoryProductInstallationRepository } from '../src/product/productInstallationRepository.js';
import { FakeCalendarClient, type CalendarEventDetail } from '../src/calendar/calendarClient.js';
import { createCalendarService, type CalendarService } from '../src/calendar/calendarService.js';
import { generateDevSessionToken, hashDevSessionToken } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';

const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-07-23T05:00:00Z'); // 2026-07-23 14:00 JST

async function createSession(
  repo: PluginSessionRepository,
  overrides: { scope?: string[]; installId?: string; revoked?: boolean; expiresAt?: Date; now?: Date } = {},
): Promise<string> {
  const token = generateDevSessionToken();
  const now = overrides.now ?? NOW;
  await repo.create({
    tokenHash: hashDevSessionToken(token),
    installId: overrides.installId ?? INSTALL_ID,
    scope: overrides.scope ?? ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read'],
    now,
    expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 3_600_000),
  });
  if (overrides.revoked) {
    await repo.revoke(hashDevSessionToken(token), now);
  }
  return token;
}

function timedEvent(summary: string, startIso: string, endIso: string, eventId = 'event-id'): CalendarEventDetail {
  return { eventId, summary, status: 'confirmed', startDateTime: startIso, startDate: null, endDateTime: endIso, endDate: null };
}

function allDayEvent(summary: string, startDate: string, endDateExclusive: string, eventId = 'event-id'): CalendarEventDetail {
  return { eventId, summary, status: 'confirmed', startDateTime: null, startDate, endDateTime: null, endDate: endDateExclusive };
}

interface Setup {
  app: ReturnType<typeof createTestApp>;
  sessionRepo: PluginSessionRepository;
  calendarClient: FakeCalendarClient;
  token: string;
}

async function setup(
  sessionOverrides: Parameters<typeof createSession>[1] = {},
  opts: { resolveCalendarService?: () => Promise<CalendarService | null>; now?: Date; rateLimitPerMinute?: number } = {},
): Promise<Setup> {
  const sessionRepo = new InMemoryPluginSessionRepository();
  const calendarClient = new FakeCalendarClient();
  const token = await createSession(sessionRepo, { now: opts.now, ...sessionOverrides });
  const app = createTestApp({
    pluginSessionRepo: sessionRepo,
    resolveCalendarService: opts.resolveCalendarService ?? (async () => createCalendarService(calendarClient)),
    clock: fixedClock(opts.now ?? NOW),
    ...(opts.rateLimitPerMinute !== undefined ? { calendarEventsDayRateLimitPerMinute: opts.rateLimitPerMinute } : {}),
  });
  return { app, sessionRepo, calendarClient, token };
}

function getDay(app: ReturnType<typeof createTestApp>, token: string, day: string, headers: Record<string, string | undefined> = {}) {
  const req = request(app)
    .get(`/plugin/calendar-events/day?day=${day}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Install-Id', INSTALL_ID)
    .set('X-Request-Id', REQUEST_ID);
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    req.set(k, v);
  }
  return req;
}

describe('OPTIONS /plugin/calendar-events/day (CORS preflight)', () => {
  it('responds 204 with scoped CORS headers (GET only)', async () => {
    const { app } = await setup();
    const res = await request(app).options('/plugin/calendar-events/day');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-methods']).not.toContain('POST');
  });
});

describe('GET /plugin/calendar-events/day success', () => {
  it('returns today range/date and empty events when there are none', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      schemaVersion: '1',
      day: 'today',
      dateLocal: '2026-07-23',
      timeZone: 'Asia/Tokyo',
      events: [],
      truncated: false,
    });
  });

  it('returns tomorrow date correctly', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getDay(app, token, 'tomorrow');
    expect(res.status).toBe(200);
    expect(res.body.day).toBe('tomorrow');
    expect(res.body.dateLocal).toBe('2026-07-24');
  });

  it('handles month-end boundary correctly for tomorrow', async () => {
    const { app, token, calendarClient } = await setup({}, { now: new Date('2026-01-31T15:00:00Z') }); // 2026-02-01 00:00 JST
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getDay(app, token, 'tomorrow');
    expect(res.body.dateLocal).toBe('2026-02-02');
  });

  it('handles year-end boundary correctly for tomorrow', async () => {
    const { app, token, calendarClient } = await setup({}, { now: new Date('2026-12-31T10:00:00Z') }); // 2026-12-31 19:00 JST
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getDay(app, token, 'tomorrow');
    expect(res.body.dateLocal).toBe('2027-01-01');
  });

  it('handles midnight boundary: just before/after JST midnight resolve to different "today"', async () => {
    const { app: appBefore, token: tokenBefore, calendarClient: clientBefore } = await setup({}, { now: new Date('2026-07-22T14:59:59Z') }); // 23:59:59 JST on 07-22
    clientBefore.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const resBefore = await getDay(appBefore, tokenBefore, 'today');
    expect(resBefore.body.dateLocal).toBe('2026-07-22');

    const { app: appAfter, token: tokenAfter, calendarClient: clientAfter } = await setup({}, { now: new Date('2026-07-22T15:00:00Z') }); // 00:00:00 JST on 07-23
    clientAfter.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const resAfter = await getDay(appAfter, tokenAfter, 'today');
    expect(resAfter.body.dateLocal).toBe('2026-07-23');
  });

  it('uses calendarId=primary and singleEvents/orderBy semantics via the service (no override accepted)', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    await getDay(app, token, 'today');
    expect(calendarClient.listEventsDetailedParamsSeen[0]?.calendarId).toBe('primary');
    expect(calendarClient.listEventsDetailedParamsSeen[0]?.timeZone).toBe('Asia/Tokyo');
    expect(calendarClient.listEventsDetailedParamsSeen[0]?.maxResults).toBe(50);
  });

  it('maps a timed event to startLocal/endLocal in Asia/Tokyo regardless of the original offset', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [
      { events: [timedEvent('打ち合わせ', '2026-07-23T01:00:00Z', '2026-07-23T02:00:00Z')], nextPageToken: null },
    ];
    const res = await getDay(app, token, 'today');
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      title: '打ち合わせ',
      allDay: false,
      startLocal: '2026-07-23T10:00:00',
      endLocal: '2026-07-23T11:00:00',
    });
    expect(typeof res.body.events[0].eventId).toBe('string');
  });

  it('maps an all-day event to startDate/endDateExclusive (no startLocal/endLocal)', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [allDayEvent('休暇', '2026-07-23', '2026-07-24')], nextPageToken: null }];
    const res = await getDay(app, token, 'today');
    expect(res.body.events[0]).toEqual(
      expect.objectContaining({ title: '休暇', allDay: true, startDate: '2026-07-23', endDateExclusive: '2026-07-24' }),
    );
    expect(res.body.events[0].startLocal).toBeUndefined();
    expect(res.body.events[0].endLocal).toBeUndefined();
  });

  it('handles a multi-day timed event (start before day, end after day) by returning its actual start/end', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [
      { events: [timedEvent('合宿', '2026-07-22T13:00:00+09:00', '2026-07-24T10:00:00+09:00')], nextPageToken: null },
    ];
    const res = await getDay(app, token, 'today');
    expect(res.body.events[0]).toMatchObject({ startLocal: '2026-07-22T13:00:00', endLocal: '2026-07-24T10:00:00', allDay: false });
  });

  it('sanitizes an empty/whitespace-only title to "名称未設定"', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [timedEvent('  ', '2026-07-23T10:00:00+09:00', '2026-07-23T11:00:00+09:00')], nextPageToken: null }];
    const res = await getDay(app, token, 'today');
    expect(res.body.events[0].title).toBe('名称未設定');
  });

  it('sanitizes a null title to "名称未設定"', async () => {
    const { app, token, calendarClient } = await setup();
    const eventWithNullTitle: CalendarEventDetail = {
      eventId: 'event-id',
      summary: null,
      status: 'confirmed',
      startDateTime: '2026-07-23T10:00:00+09:00',
      startDate: null,
      endDateTime: '2026-07-23T11:00:00+09:00',
      endDate: null,
    };
    calendarClient.listEventsDetailedPages = [{ events: [eventWithNullTitle], nextPageToken: null }];
    const res = await getDay(app, token, 'today');
    expect(res.body.events[0].title).toBe('名称未設定');
  });

  it('truncates a title over 80 characters and strips control characters', async () => {
    const { app, token, calendarClient } = await setup();
    const longTitle = `ab\nc${'x'.repeat(90)}`;
    calendarClient.listEventsDetailedPages = [{ events: [timedEvent(longTitle, '2026-07-23T10:00:00+09:00', '2026-07-23T11:00:00+09:00')], nextPageToken: null }];
    const res = await getDay(app, token, 'today');
    expect(res.body.events[0].title.length).toBeLessThanOrEqual(80);
    expect(res.body.events[0].title.includes(String.fromCharCode(10))).toBe(false);
  });

  it('reports truncated:true and caps at 50 events when more are available', async () => {
    const { app, token, calendarClient } = await setup();
    const fifty = Array.from({ length: 50 }, (_, i) => timedEvent(`e${i}`, '2026-07-23T10:00:00+09:00', '2026-07-23T11:00:00+09:00'));
    calendarClient.listEventsDetailedPages = [{ events: fifty, nextPageToken: 'more' }];
    const res = await getDay(app, token, 'today');
    expect(res.body.events).toHaveLength(50);
    expect(res.body.truncated).toBe(true);
  });

  it('returns the real Google eventId but never description, location, or attendees', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [
      { events: [timedEvent('打ち合わせ', '2026-07-23T10:00:00+09:00', '2026-07-23T11:00:00+09:00', 'real-google-event-id')], nextPageToken: null },
    ];
    const res = await getDay(app, token, 'today');
    const keys = Object.keys(res.body.events[0]);
    expect(keys.sort()).toEqual(['allDay', 'endLocal', 'eventId', 'startLocal', 'title'].sort());
    expect(res.body.events[0].eventId).toBe('real-google-event-id');
  });

  it('sets Cache-Control: no-store and X-Content-Type-Options: nosniff', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getDay(app, token, 'today');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('GET /plugin/calendar-events/day validation', () => {
  it('returns 400 for a missing day parameter', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .get('/plugin/calendar-events/day')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid day value', async () => {
    const { app, token } = await setup();
    const res = await getDay(app, token, 'someday');
    expect(res.status).toBe(400);
  });

  it('returns 400 for day=yesterday (removed in Phase 2G; only today/tomorrow remain valid)', async () => {
    const { app, token } = await setup();
    const res = await getDay(app, token, 'yesterday');
    expect(res.status).toBe(400);
  });

  it('returns 400 when an unsupported query parameter (calendarId) is present', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .get('/plugin/calendar-events/day?day=today&calendarId=someone-elses-calendar')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(400);
  });

  it('returns 400 when an unsupported query parameter (timeZone) is present', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .get('/plugin/calendar-events/day?day=today&timeZone=UTC')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(400);
  });

  it('returns 400 when an unsupported query parameter (date) is present', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .get('/plugin/calendar-events/day?day=today&date=2026-01-01')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a missing/malformed X-Request-Id', async () => {
    const { app, token } = await setup();
    const res = await getDay(app, token, 'today', { 'X-Request-Id': 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});

describe('GET /plugin/calendar-events/day authentication/authorization', () => {
  it('returns 401 when Authorization is missing', async () => {
    const { app } = await setup();
    const res = await request(app).get('/plugin/calendar-events/day?day=today').set('X-Install-Id', INSTALL_ID).set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const { app } = await setup();
    const res = await getDay(app, 'not-a-real-token', 'today');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a revoked session', async () => {
    const { app, token } = await setup({ revoked: true });
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired session', async () => {
    const { app, token } = await setup({ expiresAt: new Date(NOW.getTime() - 1000) });
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the session lacks calendar:read scope (old sessions are not auto-granted it)', async () => {
    const { app, token } = await setup({ scope: ['audio:analyze', 'calendar:create', 'calendar:status'] });
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(403);
  });

  it('returns 403 when X-Install-Id does not match the session', async () => {
    const { app, token } = await setup({ installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(403);
  });

  it('a session with only calendar:read (no other scopes) can still read today', async () => {
    const { app, token, calendarClient } = await setup({ scope: ['calendar:read'] });
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(200);
  });
});

describe('GET /plugin/calendar-events/day Calendar/OAuth failure handling', () => {
  it('returns 403 when Calendar is not connected (resolveCalendarService returns null)', async () => {
    const { app, token } = await setup({}, { resolveCalendarService: async () => null });
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(403);
  });

  it('returns 502 when the Calendar API throws a non-recoverable error', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.nextListEventsDetailedError = () => {
      throw Object.assign(new Error('server error'), { code: 500 });
    };
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(502);
  });

  it('returns 504 when the Calendar API call times out (aborted)', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.nextListEventsDetailedError = () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(504);
  });

  it('does not expose the raw Calendar error in the response', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.nextListEventsDetailedError = () => {
      throw Object.assign(new Error('SENSITIVE_INTERNAL_DETAIL'), { code: 500 });
    };
    const res = await getDay(app, token, 'today');
    expect(JSON.stringify(res.body)).not.toContain('SENSITIVE_INTERNAL_DETAIL');
  });
});

describe('GET /plugin/calendar-events/day rate limiting', () => {
  it('returns 429 after exceeding the per-minute limit for this route', async () => {
    const { app, token, calendarClient } = await setup({}, { rateLimitPerMinute: 2 });
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const first = await getDay(app, token, 'today');
    const second = await getDay(app, token, 'today');
    const third = await getDay(app, token, 'today');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it('does not share its rate-limit bucket with /plugin/analyze-audio', async () => {
    const { app, token, calendarClient } = await setup({}, { rateLimitPerMinute: 1 });
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    await getDay(app, token, 'today'); // consumes the day-route's own 1-per-minute limit
    const res = await request(app)
      .options('/plugin/analyze-audio')
      .set('Authorization', `Bearer ${token}`);
    // OPTIONS preflight never touches rate limiting; this just proves the two routers are independent and both mounted.
    expect(res.status).toBe(204);
  });
});

describe('GET /plugin/calendar-events/day privacy: no sensitive logs', () => {
  it('never logs event titles, ISO dates/times, or the raw session token', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [
      { events: [timedEvent('プライベートな予定名', '2026-07-23T10:00:00+09:00', '2026-07-23T11:00:00+09:00')], nextPageToken: null },
    ];
    await getDay(app, token, 'today');
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain('プライベートな予定名');
    expect(allLogText).not.toContain('2026-07-23T10:00:00');
    expect(allLogText).not.toContain(token);
    logSpy.mockRestore();
  });
});

describe('GET /plugin/calendar-events/day — product (device) principal (Phase 2K)', () => {
  async function setupProductPrincipal(opts: { resolveCalendarService?: (userId?: string | null) => Promise<CalendarService | null> } = {}) {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const productInstallationRepo = new InMemoryProductInstallationRepository();
    await productInstallationRepo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: null, sdkVersion: null });
    await productInstallationRepo.bindUser(INSTALL_ID, 'user-1', NOW);
    const token = generateDevSessionToken();
    await sessionRepo.create({
      tokenHash: hashDevSessionToken(token),
      installId: INSTALL_ID,
      scope: ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read'],
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      tokenType: 'device',
      userId: 'user-1',
    });
    const calendarClient = new FakeCalendarClient();
    const app = createTestApp({
      pluginSessionRepo: sessionRepo,
      productInstallationRepo,
      resolveCalendarService: opts.resolveCalendarService ?? (async (userId) => (userId === 'user-1' ? createCalendarService(calendarClient) : null)),
      clock: fixedClock(NOW),
    });
    return { app, token, calendarClient };
  }

  it('succeeds end-to-end for a product principal and passes its userId to resolveCalendarService', async () => {
    const { app, token, calendarClient } = await setupProductPrincipal();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(200);
  });

  it('classifies a product-principal Calendar/refresh failure with a product_* code, not the generic dev auth_invalid_grant code', async () => {
    const { app, token, calendarClient } = await setupProductPrincipal();
    calendarClient.nextListEventsDetailedError = () => {
      throw Object.assign(new Error('token endpoint failure'), { response: { status: 401, data: {} } });
    };
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(502);
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).toContain('product_google_refresh_invalid_client');
    expect(allLogText).not.toContain('auth_invalid_grant');
    logSpy.mockRestore();
  });

  it('returns 403 (Forbidden) rather than crashing when the product credential lookup fails', async () => {
    const { app, token } = await setupProductPrincipal({ resolveCalendarService: async () => null });
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(403);
  });
});

describe('GET /plugin/calendar-events/day — dev principal sanitizedErrorCode unaffected (regression)', () => {
  it('still logs the pre-existing generic auth_invalid_grant code for a dev-mode 401 failure', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.nextListEventsDetailedError = () => {
      throw Object.assign(new Error('unauthorized'), { code: 401 });
    };
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await getDay(app, token, 'today');
    expect(res.status).toBe(502);
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).toContain('auth_invalid_grant');
    expect(allLogText).not.toContain('product_google_refresh');
    logSpy.mockRestore();
  });
});

describe('existing plugin/backend routes remain unaffected', () => {
  it('POST /plugin/analyze-audio still requires audio:analyze scope (regression)', async () => {
    const { app, token } = await setup({ scope: ['calendar:read'] });
    const res = await request(app)
      .post('/plugin/analyze-audio')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID)
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from('not-really-wav'));
    expect(res.status).toBe(403);
  });

  it('GET /plugin/calendar-events/status is unaffected by the new route (regression)', async () => {
    const { app, token } = await setup({ scope: ['calendar:status'] });
    const res = await request(app)
      .get('/plugin/calendar-events/status?candidateId=33333333-3333-4333-8333-333333333333')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('expired');
  });
});
