import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';
import { InMemoryPluginSessionRepository, type PluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { InMemoryProductInstallationRepository } from '../src/product/productInstallationRepository.js';
import { InMemoryIdempotencyRepository } from '../src/firestore/idempotencyRepository.js';
import { FakeCalendarClient, type CalendarEventFullDetail } from '../src/calendar/calendarClient.js';
import { createCalendarService, type CalendarService } from '../src/calendar/calendarService.js';
import { generateDevSessionToken, hashDevSessionToken } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';

const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-07-23T05:00:00Z'); // 2026-07-23 14:00 JST
const ALL_SCOPES = ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read', 'calendar:update', 'calendar:delete'];

async function createSession(
  repo: PluginSessionRepository,
  overrides: { scope?: string[]; installId?: string; revoked?: boolean; expiresAt?: Date; now?: Date } = {},
): Promise<string> {
  const token = generateDevSessionToken();
  const now = overrides.now ?? NOW;
  await repo.create({
    tokenHash: hashDevSessionToken(token),
    installId: overrides.installId ?? INSTALL_ID,
    scope: overrides.scope ?? ALL_SCOPES,
    now,
    expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 3_600_000),
  });
  if (overrides.revoked) {
    await repo.revoke(hashDevSessionToken(token), now);
  }
  return token;
}

function fullDetail(overrides: Partial<CalendarEventFullDetail> = {}): CalendarEventFullDetail {
  return {
    eventId: 'evt-1',
    status: 'confirmed',
    summary: '打ち合わせ',
    description: null,
    location: null,
    startDateTime: '2026-07-23T15:00:00+09:00',
    startDate: null,
    endDateTime: '2026-07-23T16:00:00+09:00',
    endDate: null,
    attendees: null,
    conferenceJoinUrl: null,
    etag: '"etag-1"',
    ...overrides,
  };
}

interface Setup {
  app: ReturnType<typeof createTestApp>;
  sessionRepo: PluginSessionRepository;
  calendarClient: FakeCalendarClient;
  token: string;
}

async function setup(
  sessionOverrides: Parameters<typeof createSession>[1] = {},
  opts: { resolveCalendarService?: (userId?: string | null) => Promise<CalendarService | null>; now?: Date; rateLimitPerMinute?: number } = {},
): Promise<Setup> {
  const sessionRepo = new InMemoryPluginSessionRepository();
  const calendarClient = new FakeCalendarClient();
  const token = await createSession(sessionRepo, { now: opts.now, ...sessionOverrides });
  const app = createTestApp({
    pluginSessionRepo: sessionRepo,
    resolveCalendarService: opts.resolveCalendarService ?? (async () => createCalendarService(calendarClient)),
    clock: fixedClock(opts.now ?? NOW),
    ...(opts.rateLimitPerMinute !== undefined ? { calendarEventsItemRateLimitPerMinute: opts.rateLimitPerMinute } : {}),
  });
  return { app, sessionRepo, calendarClient, token };
}

function getDetail(app: ReturnType<typeof createTestApp>, token: string, eventId: string, headers: Record<string, string | undefined> = {}) {
  const req = request(app)
    .get(`/plugin/calendar-events/${eventId}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Install-Id', INSTALL_ID)
    .set('X-Request-Id', REQUEST_ID);
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    req.set(k, v);
  }
  return req;
}

function patchEvent(
  app: ReturnType<typeof createTestApp>,
  token: string,
  eventId: string,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined> = {},
) {
  const req = request(app)
    .patch(`/plugin/calendar-events/${eventId}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Install-Id', INSTALL_ID)
    .set('X-Request-Id', REQUEST_ID)
    .send(body);
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    req.set(k, v);
  }
  return req;
}

function deleteEvent(
  app: ReturnType<typeof createTestApp>,
  token: string,
  eventId: string,
  idempotencyKey: string | null = IDEMPOTENCY_KEY,
  headers: Record<string, string | undefined> = {},
) {
  const req = request(app)
    .delete(`/plugin/calendar-events/${eventId}${idempotencyKey !== null ? `?idempotencyKey=${idempotencyKey}` : ''}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Install-Id', INSTALL_ID)
    .set('X-Request-Id', REQUEST_ID);
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    req.set(k, v);
  }
  return req;
}

describe('OPTIONS /plugin/calendar-events/:eventId (CORS preflight)', () => {
  it('responds 204 with scoped CORS headers (GET, PATCH, DELETE)', async () => {
    const { app } = await setup();
    const res = await request(app).options('/plugin/calendar-events/evt-1');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
  });
});

describe('existing specific-path calendar-events routes are unaffected by the new :eventId route', () => {
  it('GET /plugin/calendar-events/day still works (regression: not shadowed by :eventId)', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const res = await request(app)
      .get('/plugin/calendar-events/day?day=today')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(200);
  });

  it('GET /plugin/calendar-events/status still works (regression: not shadowed by :eventId)', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .get(`/plugin/calendar-events/status?candidateId=${IDEMPOTENCY_KEY}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('expired');
  });
});

describe('GET /plugin/calendar-events/:eventId success', () => {
  it('returns full detail including location/description/attendees/meetingUrl when present', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set(
      'evt-1',
      fullDetail({
        location: '会議室A',
        description: 'メモ',
        attendees: [{ email: 'a@example.com', displayName: 'A', responseStatus: 'accepted' }],
        conferenceJoinUrl: 'https://meet.example.com/xyz',
      }),
    );
    const res = await getDetail(app, token, 'evt-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      schemaVersion: '1',
      event: {
        eventId: 'evt-1',
        title: '打ち合わせ',
        status: 'confirmed',
        allDay: false,
        startLocal: '2026-07-23T15:00:00',
        endLocal: '2026-07-23T16:00:00',
        location: '会議室A',
        description: 'メモ',
        attendees: [{ email: 'a@example.com', displayName: 'A', responseStatus: 'accepted' }],
        meetingUrl: 'https://meet.example.com/xyz',
        etag: '"etag-1"',
      },
    });
  });

  it('omits location/description/attendees/meetingUrl/etag keys entirely when absent (no placeholders)', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail({ etag: null }));
    const res = await getDetail(app, token, 'evt-1');
    expect(res.status).toBe(200);
    const keys = Object.keys(res.body.event).sort();
    expect(keys).toEqual(['allDay', 'endLocal', 'eventId', 'startLocal', 'status', 'title'].sort());
  });

  it('sets Cache-Control: no-store and X-Content-Type-Options: nosniff', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    const res = await getDetail(app, token, 'evt-1');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('GET /plugin/calendar-events/:eventId not found / validation', () => {
  it('returns 404 for an eventId that does not exist (or was already deleted)', async () => {
    const { app, token } = await setup();
    const res = await getDetail(app, token, 'nonexistent-event-id');
    expect(res.status).toBe(404);
  });

  it('rejects a malformed eventId (too short) with 400', async () => {
    const { app, token } = await setup();
    const res = await getDetail(app, token, 'ab');
    expect(res.status).toBe(400);
  });

  it('rejects a malformed eventId (invalid characters) with 400', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .get('/plugin/calendar-events/evt%2Fwith%2Fslash')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a missing/malformed X-Request-Id', async () => {
    const { app, token } = await setup();
    const res = await getDetail(app, token, 'evt-1', { 'X-Request-Id': 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});

describe('GET /plugin/calendar-events/:eventId authentication/authorization', () => {
  it('returns 401 when Authorization is missing', async () => {
    const { app } = await setup();
    const res = await request(app).get('/plugin/calendar-events/evt-1').set('X-Install-Id', INSTALL_ID).set('X-Request-Id', REQUEST_ID);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the session lacks calendar:read scope', async () => {
    const { app, token } = await setup({ scope: ['calendar:update', 'calendar:delete'] });
    const res = await getDetail(app, token, 'evt-1');
    expect(res.status).toBe(403);
  });

  it('returns 403 when Calendar is not connected (resolveCalendarService returns null)', async () => {
    const { app, token } = await setup({}, { resolveCalendarService: async () => null });
    const res = await getDetail(app, token, 'evt-1');
    expect(res.status).toBe(403);
  });
});

describe('PATCH /plugin/calendar-events/:eventId', () => {
  it('updates only the specified fields and returns {eventId, status: updated}', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail({ location: '会議室A' }));
    const res = await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY, title: '新タイトル' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eventId: 'evt-1', status: 'updated' });
    expect(calendarClient.eventStore.get('evt-1')?.location).toBe('会議室A');
    expect(calendarClient.eventStore.get('evt-1')?.summary).toBe('新タイトル');
  });

  it('returns 400 when start/end would be invalid after merging', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    const res = await patchEvent(app, token, 'evt-1', {
      idempotencyKey: IDEMPOTENCY_KEY,
      startLocal: '2026-07-23T18:00:00',
      endLocal: '2026-07-23T17:00:00',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when idempotencyKey is missing', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    const res = await patchEvent(app, token, 'evt-1', { title: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when no updatable field is provided (only idempotencyKey)', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    const res = await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the target event no longer exists', async () => {
    const { app, token } = await setup();
    const res = await patchEvent(app, token, 'missing-event', { idempotencyKey: IDEMPOTENCY_KEY, title: 'x' });
    expect(res.status).toBe(404);
  });

  it('returns 409 on a Calendar 412 conflict (concurrent edit from another device)', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    calendarClient.nextPatchEventError = () => {
      throw Object.assign(new Error('conflict'), { code: 412 });
    };
    const res = await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY, title: 'x' });
    expect(res.status).toBe(409);
  });

  it('does not call events.patch twice for a retried request with the same idempotencyKey', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    const first = await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY, title: 'x' });
    const second = await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY, title: 'x' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calendarClient.patchCallCount).toBe(1);
  });

  it('returns 403 when the session lacks calendar:update scope', async () => {
    const { app, token, calendarClient } = await setup({ scope: ['calendar:read'] });
    calendarClient.eventStore.set('evt-1', fullDetail());
    const res = await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY, title: 'x' });
    expect(res.status).toBe(403);
  });

  it('never logs or returns the updated title/location/description', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    const res = await patchEvent(app, token, 'evt-1', {
      idempotencyKey: IDEMPOTENCY_KEY,
      title: 'UNIQUE_TITLE_SENTINEL',
      location: 'UNIQUE_LOCATION_SENTINEL',
    });
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain('UNIQUE_TITLE_SENTINEL');
    expect(allLogText).not.toContain('UNIQUE_LOCATION_SENTINEL');
    expect(JSON.stringify(res.body)).not.toContain('UNIQUE_TITLE_SENTINEL');
    logSpy.mockRestore();
  });

  it('— product (device) principal — classifies a Calendar failure with a product_* code, not the generic dev code', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const productInstallationRepo = new InMemoryProductInstallationRepository();
    await productInstallationRepo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: null, sdkVersion: null });
    await productInstallationRepo.bindUser(INSTALL_ID, 'user-1', NOW);
    const token = generateDevSessionToken();
    await sessionRepo.create({
      tokenHash: hashDevSessionToken(token),
      installId: INSTALL_ID,
      scope: ALL_SCOPES,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      tokenType: 'device',
      userId: 'user-1',
    });
    const calendarClient = new FakeCalendarClient();
    calendarClient.eventStore.set('evt-1', fullDetail());
    calendarClient.nextPatchEventError = () => {
      throw Object.assign(new Error('token endpoint failure'), { response: { status: 401, data: {} } });
    };
    const app = createTestApp({
      pluginSessionRepo: sessionRepo,
      productInstallationRepo,
      resolveCalendarService: async (userId) => (userId === 'user-1' ? createCalendarService(calendarClient) : null),
      clock: fixedClock(NOW),
    });

    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY, title: 'x' });
    expect(res.status).toBe(502);
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).toContain('product_google_refresh_invalid_client');
    expect(allLogText).not.toContain('auth_invalid_grant');
    logSpy.mockRestore();
  });
});

describe('DELETE /plugin/calendar-events/:eventId', () => {
  it('deletes an existing event and returns {eventId, status: deleted}', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    const res = await deleteEvent(app, token, 'evt-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eventId: 'evt-1', status: 'deleted' });
    expect(calendarClient.eventStore.has('evt-1')).toBe(false);
  });

  it('treats deleting an already-deleted event as success (200), not an error', async () => {
    const { app, token } = await setup();
    const res = await deleteEvent(app, token, 'already-deleted-event');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deleted');
  });

  it('returns 400 when idempotencyKey query parameter is missing', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    const res = await deleteEvent(app, token, 'evt-1', null);
    expect(res.status).toBe(400);
  });

  it('does not call events.delete twice for a retried request with the same idempotencyKey', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    const first = await deleteEvent(app, token, 'evt-1');
    const second = await deleteEvent(app, token, 'evt-1');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calendarClient.deleteCallCount).toBe(1);
  });

  it('returns 403 when the session lacks calendar:delete scope', async () => {
    const { app, token, calendarClient } = await setup({ scope: ['calendar:read', 'calendar:update'] });
    calendarClient.eventStore.set('evt-1', fullDetail());
    const res = await deleteEvent(app, token, 'evt-1');
    expect(res.status).toBe(403);
  });

  it('returns 401 for a revoked session', async () => {
    const { app, token } = await setup({ revoked: true });
    const res = await deleteEvent(app, token, 'evt-1');
    expect(res.status).toBe(401);
  });

  it('never logs the raw session token or eventId', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    await deleteEvent(app, token, 'evt-1');
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain(token);
    expect(allLogText).not.toContain('evt-1');
    logSpy.mockRestore();
  });
});

describe('rate limiting for /plugin/calendar-events/:eventId', () => {
  it('returns 429 after exceeding the per-minute limit, independent of the day/upcoming buckets', async () => {
    const { app, token, calendarClient } = await setup({}, { rateLimitPerMinute: 2 });
    calendarClient.eventStore.set('evt-1', fullDetail());
    const first = await getDetail(app, token, 'evt-1');
    const second = await getDetail(app, token, 'evt-1');
    const third = await getDetail(app, token, 'evt-1');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });
});

describe('Calendar API timeout handling (504)', () => {
  it('GET detail returns 504 when the Calendar API call is aborted', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    calendarClient.nextGetEventDetailError = () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const res = await getDetail(app, token, 'evt-1');
    expect(res.status).toBe(504);
  });

  it('PATCH returns 504 when the Calendar patch call is aborted', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    calendarClient.nextPatchEventError = () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const res = await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY, title: 'x' });
    expect(res.status).toBe(504);
  });

  it('DELETE returns 504 when the Calendar delete call is aborted', async () => {
    const { app, token, calendarClient } = await setup();
    calendarClient.eventStore.set('evt-1', fullDetail());
    calendarClient.nextDeleteEventError = () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const res = await deleteEvent(app, token, 'evt-1');
    expect(res.status).toBe(504);
  });
});

describe('additional scope/oauth edge cases', () => {
  it('DELETE returns 503 when Calendar is not connected (resolveCalendarService returns null)', async () => {
    const { app, token } = await setup({}, { resolveCalendarService: async () => null });
    const res = await deleteEvent(app, token, 'evt-1');
    // resolveCalendarServiceがnullを返す場合はサービス層でoauth_not_connectedとして扱われ503を返す
    expect(res.status).toBe(503);
  });

  it('PATCH returns 503 when Calendar is not connected (resolveCalendarService returns null)', async () => {
    const { app, token } = await setup({}, { resolveCalendarService: async () => null });
    const res = await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY, title: 'x' });
    expect(res.status).toBe(503);
  });
});

describe('idempotencyRepo is shared with app-level config when provided', () => {
  it('honors an injected idempotencyRepo (retry does not call Calendar a second time)', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const token = await createSession(sessionRepo);
    const calendarClient = new FakeCalendarClient();
    calendarClient.eventStore.set('evt-1', fullDetail());
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    const app = createTestApp({
      pluginSessionRepo: sessionRepo,
      resolveCalendarService: async () => createCalendarService(calendarClient),
      clock: fixedClock(NOW),
      idempotencyRepo,
    });

    await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY, title: 'x' });
    await patchEvent(app, token, 'evt-1', { idempotencyKey: IDEMPOTENCY_KEY, title: 'x' });
    expect(calendarClient.patchCallCount).toBe(1);

    const doc = await idempotencyRepo.get(IDEMPOTENCY_KEY);
    expect(doc?.status).toBe('completed');
  });
});
