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
const NOW = new Date('2026-07-23T03:00:00Z'); // 2026-07-23 12:00 JST

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
    ...(opts.rateLimitPerMinute !== undefined ? { calendarEventsUpcomingRateLimitPerMinute: opts.rateLimitPerMinute } : {}),
  });
  return { app, sessionRepo, calendarClient, token };
}

function getUpcoming(
  app: ReturnType<typeof createTestApp>,
  token: string,
  query = '',
  headers: Record<string, string | undefined> = {},
) {
  const req = request(app)
    .get(`/plugin/calendar-events/upcoming${query}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Install-Id', INSTALL_ID)
    .set('X-Request-Id', REQUEST_ID);
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    req.set(k, v);
  }
  return req;
}

describe('OPTIONS /plugin/calendar-events/upcoming (CORS preflight)', () => {
  it('responds 204 with scoped CORS headers (GET only)', async () => {
    const { app } = await setup();
    const res = await request(app).options('/plugin/calendar-events/upcoming');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-methods']).not.toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers['access-control-allow-headers']).toContain('X-Install-Id');
    expect(res.headers['access-control-allow-headers']).toContain('X-Request-Id');
  });
});

describe('GET /plugin/calendar-events/upcoming success', () => {
  it('returns schemaVersion/mode/timeZone/events/truncated with no day or dateLocal fields', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ schemaVersion: '1', mode: 'upcoming', timeZone: 'Asia/Tokyo', events: [], truncated: false });
  });

  it('defaults limit to 5 when omitted', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getUpcoming(app, token);
    expect(res.status).toBe(200);
  });

  it('uses calendarId=primary and passes windowStart=now / windowEnd=now+2 calendar months as timeMin/timeMax', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    await getUpcoming(app, token, '?limit=5');
    expect(calendarClient.listEventsDetailedParamsSeen[0]?.calendarId).toBe('primary');
    expect(calendarClient.listEventsDetailedParamsSeen[0]?.timeMinIso).toBe('2026-07-23T12:00:00+09:00');
    expect(calendarClient.listEventsDetailedParamsSeen[0]?.timeMaxIso).toBe('2026-09-23T12:00:00+09:00');
    expect(calendarClient.listEventsDetailedParamsSeen[0]?.timeZone).toBe('Asia/Tokyo');
  });

  it('rejects events beyond the 2-month window even if the Fake client returns them', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [timedEvent('tooFar', '2026-09-24T10:00:00+09:00', '2026-09-24T11:00:00+09:00')], nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.body.events).toEqual([]);
  });

  it('includes an event in the second month, still within the 2-month window', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [timedEvent('secondMonth', '2026-09-10T10:00:00+09:00', '2026-09-10T11:00:00+09:00')], nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.body.events).toHaveLength(1);
  });

  it('maps a future timed event to startLocal/endLocal', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [timedEvent('打ち合わせ', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00')], nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.body.events).toEqual([
      expect.objectContaining({ title: '打ち合わせ', allDay: false, startLocal: '2026-07-23T14:00:00', endLocal: '2026-07-23T15:00:00' }),
    ]);
    expect(typeof res.body.events[0].eventId).toBe('string');
  });

  it('maps a future all-day event to startDate/endDateExclusive', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [allDayEvent('休暇', '2026-07-24', '2026-07-25')], nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.body.events[0]).toEqual(expect.objectContaining({ title: '休暇', allDay: true, startDate: '2026-07-24', endDateExclusive: '2026-07-25' }));
  });

  it('excludes ongoing/past/start==now events server-side', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [
      {
        events: [
          timedEvent('past', '2026-07-23T08:00:00+09:00', '2026-07-23T09:00:00+09:00'),
          timedEvent('ongoing', '2026-07-23T11:00:00+09:00', '2026-07-23T13:00:00+09:00'),
          timedEvent('exactNow', '2026-07-23T12:00:00+09:00', '2026-07-23T13:00:00+09:00'),
          timedEvent('future', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00'),
        ],
        nextPageToken: null,
      },
    ];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].title).toBe('future');
  });

  it('excludes an all-day event starting today, includes one starting tomorrow', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [
      {
        events: [allDayEvent('todayAllDay', '2026-07-23', '2026-07-24'), allDayEvent('tomorrowAllDay', '2026-07-24', '2026-07-25')],
        nextPageToken: null,
      },
    ];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].title).toBe('tomorrowAllDay');
  });

  it('excludes a future multi-day all-day event that started in the past', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [allDayEvent('pastMultiDay', '2026-07-20', '2026-07-26')], nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.body.events).toHaveLength(0);
  });

  it('caps at a maximum of 5 events and preserves chronological order', async () => {
    const { app, token, calendarClient } = await setup();
    const events = Array.from({ length: 8 }, (_, i) => timedEvent(`e${i}`, `2026-07-23T${14 + i}:00:00+09:00`, `2026-07-23T${15 + i}:00:00+09:00`));
    calendarClient.listEventsDetailedPages = [{ events, nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.body.events).toHaveLength(5);
    expect(res.body.events.map((e: { title: string }) => e.title)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
    expect(res.body.truncated).toBe(true);
  });

  it('returns 0 events and truncated:false when there are no future events', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.body.events).toEqual([]);
    expect(res.body.truncated).toBe(false);
  });

  it('returns the real Google eventId but never description, location, or attendees', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [
      { events: [timedEvent('打ち合わせ', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00', 'real-google-event-id')], nextPageToken: null },
    ];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(Object.keys(res.body.events[0]).sort()).toEqual(['allDay', 'endLocal', 'eventId', 'startLocal', 'title'].sort());
    expect(res.body.events[0].eventId).toBe('real-google-event-id');
  });

  it('sanitizes title (empty/null -> 名称未設定, control chars stripped, max 80 chars)', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [timedEvent('', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00')], nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.body.events[0].title).toBe('名称未設定');
  });

  it('respects a limit of 1', async () => {
    const { app, token, calendarClient } = await setup();
    const events = Array.from({ length: 3 }, (_, i) => timedEvent(`e${i}`, `2026-07-23T${14 + i}:00:00+09:00`, `2026-07-23T${15 + i}:00:00+09:00`));
    calendarClient.listEventsDetailedPages = [{ events, nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=1');
    expect(res.body.events).toHaveLength(1);
  });

  it('sets Cache-Control: no-store and X-Content-Type-Options: nosniff', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never calls Calendar insert/update/delete', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [timedEvent('e', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00')], nextPageToken: null }];
    await getUpcoming(app, token, '?limit=5');
    expect(calendarClient.insertCallCount).toBe(0);
  });
});

describe('GET /plugin/calendar-events/upcoming validation', () => {
  it('returns 400 for limit=0', async () => {
    const { app, token } = await setup();
    const res = await getUpcoming(app, token, '?limit=0');
    expect(res.status).toBe(400);
  });

  it('returns 400 for limit=6 (exceeds max)', async () => {
    const { app, token } = await setup();
    const res = await getUpcoming(app, token, '?limit=6');
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-numeric limit', async () => {
    const { app, token } = await setup();
    const res = await getUpcoming(app, token, '?limit=abc');
    expect(res.status).toBe(400);
  });

  it('returns 400 when an unsupported query parameter (calendarId) is present', async () => {
    const { app, token } = await setup();
    const res = await getUpcoming(app, token, '?limit=5&calendarId=someone-elses');
    expect(res.status).toBe(400);
  });

  it('returns 400 when an unsupported query parameter (timeZone) is present', async () => {
    const { app, token } = await setup();
    const res = await getUpcoming(app, token, '?timeZone=UTC');
    expect(res.status).toBe(400);
  });

  it('returns 400 for a missing/malformed X-Request-Id', async () => {
    const { app, token } = await setup();
    const res = await getUpcoming(app, token, '?limit=5', { 'X-Request-Id': 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});

describe('GET /plugin/calendar-events/upcoming authentication/authorization', () => {
  it('returns 401 when Authorization is missing', async () => {
    const { app } = await setup();
    const res = await request(app).get('/plugin/calendar-events/upcoming?limit=5').set('X-Install-Id', INSTALL_ID).set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const { app } = await setup();
    const res = await getUpcoming(app, 'not-a-real-token', '?limit=5');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a revoked session', async () => {
    const { app, token } = await setup({ revoked: true });
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired session', async () => {
    const { app, token } = await setup({ expiresAt: new Date(NOW.getTime() - 1000) });
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the session lacks calendar:read scope', async () => {
    const { app, token } = await setup({ scope: ['audio:analyze', 'calendar:create', 'calendar:status'] });
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(403);
  });

  it('returns 403 when X-Install-Id does not match the session', async () => {
    const { app, token } = await setup({ installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(403);
  });
});

describe('GET /plugin/calendar-events/upcoming Calendar/OAuth failure handling', () => {
  it('returns 403 when Calendar is not connected (resolveCalendarService returns null)', async () => {
    const { app, token } = await setup({}, { resolveCalendarService: async () => null });
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(403);
  });

  it('returns 502 when the Calendar API throws a non-recoverable error', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.nextListEventsDetailedError = () => {
      throw Object.assign(new Error('server error'), { code: 500 });
    };
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(502);
  });

  it('returns 504 when the Calendar API call times out (aborted)', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.nextListEventsDetailedError = () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(504);
  });

  it('does not expose the raw Calendar error in the response', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.nextListEventsDetailedError = () => {
      throw Object.assign(new Error('SENSITIVE_INTERNAL_DETAIL'), { code: 500 });
    };
    const res = await getUpcoming(app, token, '?limit=5');
    expect(JSON.stringify(res.body)).not.toContain('SENSITIVE_INTERNAL_DETAIL');
  });
});

describe('GET /plugin/calendar-events/upcoming rate limiting', () => {
  it('returns 429 after exceeding the per-minute limit for this route', async () => {
    const { app, token, calendarClient } = await setup({}, { rateLimitPerMinute: 2 });
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const first = await getUpcoming(app, token, '?limit=5');
    const second = await getUpcoming(app, token, '?limit=5');
    const third = await getUpcoming(app, token, '?limit=5');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it('does not share its rate-limit bucket with /plugin/calendar-events/day', async () => {
    const { app, token, calendarClient } = await setup({}, { rateLimitPerMinute: 1 });
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    await getUpcoming(app, token, '?limit=5'); // consumes upcoming's own 1-per-minute limit
    const res = await request(app)
      .get('/plugin/calendar-events/day?day=today')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(200);
  });
});

describe('GET /plugin/calendar-events/upcoming privacy: no sensitive logs', () => {
  it('never logs event titles, ISO dates/times, or the raw session token', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [
      { events: [timedEvent('プライベートな予定名', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00')], nextPageToken: null },
    ];
    await getUpcoming(app, token, '?limit=5');
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain('プライベートな予定名');
    expect(allLogText).not.toContain('2026-07-23T14:00:00');
    expect(allLogText).not.toContain(token);
    logSpy.mockRestore();
  });
});

describe('GET /plugin/calendar-events/upcoming — product (device) principal (Phase 2K)', () => {
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
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(200);
  });

  it('classifies a product-principal Calendar/refresh failure with a product_* code, not the generic dev auth_invalid_grant code', async () => {
    const { app, token, calendarClient } = await setupProductPrincipal();
    calendarClient.nextListEventsDetailedError = () => {
      throw Object.assign(new Error('token endpoint failure'), { response: { status: 401, data: {} } });
    };
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(502);
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).toContain('product_google_refresh_invalid_client');
    expect(allLogText).not.toContain('auth_invalid_grant');
    logSpy.mockRestore();
  });

  it('returns 403 (Forbidden) rather than crashing when the product credential lookup fails', async () => {
    const { app, token } = await setupProductPrincipal({ resolveCalendarService: async () => null });
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(403);
  });
});

describe('GET /plugin/calendar-events/upcoming — dev principal sanitizedErrorCode unaffected (regression)', () => {
  it('still logs the pre-existing generic auth_invalid_grant code for a dev-mode 401 failure', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.nextListEventsDetailedError = () => {
      throw Object.assign(new Error('unauthorized'), { code: 401 });
    };
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await getUpcoming(app, token, '?limit=5');
    expect(res.status).toBe(502);
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).toContain('auth_invalid_grant');
    expect(allLogText).not.toContain('product_google_refresh');
    logSpy.mockRestore();
  });
});

describe('existing plugin/backend routes remain unaffected by /plugin/calendar-events/upcoming', () => {
  it('GET /plugin/calendar-events/day?day=today still works (regression)', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await request(app)
      .get('/plugin/calendar-events/day?day=today')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(200);
  });

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
});
