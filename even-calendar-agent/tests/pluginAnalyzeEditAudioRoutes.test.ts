import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';
import { InMemoryPluginSessionRepository, type PluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { InMemoryPluginRateLimitRepository } from '../src/firestore/pluginRateLimitRepository.js';
import { InMemoryPluginRequestDedupeRepository } from '../src/firestore/pluginRequestDedupeRepository.js';
import { FakeCalendarClient, type CalendarEventFullDetail } from '../src/calendar/calendarClient.js';
import { createCalendarService, type CalendarService } from '../src/calendar/calendarService.js';
import { FakeGeminiClient } from '../src/gemini/geminiClient.js';
import { generateDevSessionToken, hashDevSessionToken } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';
import { buildWav } from './helpers/buildWav.js';

const INSTALL_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const EVENT_ID = 'evt-1';
const NOW = new Date('2026-07-23T05:00:00Z'); // 2026-07-23 14:00 JST

async function createSession(
  repo: PluginSessionRepository,
  overrides: { installId?: string; scope?: string[]; now?: Date; expiresAt?: Date; revoked?: boolean } = {},
): Promise<string> {
  const token = generateDevSessionToken();
  const now = overrides.now ?? NOW;
  await repo.create({
    tokenHash: hashDevSessionToken(token),
    installId: overrides.installId ?? INSTALL_ID,
    scope: overrides.scope ?? ['audio:analyze'],
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
    eventId: EVENT_ID,
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

/** Gemini生JSON(edit instruction形式)を組み立てる。既定はresultType="not_understood"かつ全フィールドnull。 */
function editInstructionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: '1',
    resultType: 'not_understood',
    title: null,
    location: null,
    description: null,
    startLocal: null,
    endLocal: null,
    allDay: null,
    startDate: null,
    endDateExclusive: null,
    ...overrides,
  });
}

interface TestSetup {
  app: ReturnType<typeof createTestApp>;
  sessionRepo: PluginSessionRepository;
  calendarClient: FakeCalendarClient;
  geminiClient: FakeGeminiClient;
  token: string;
}

async function setup(
  sessionOverrides: Parameters<typeof createSession>[1] = {},
  opts: {
    resolveCalendarService?: (userId?: string | null) => Promise<CalendarService | null>;
    eventDetail?: CalendarEventFullDetail | null;
    geminiTimeoutMs?: number;
  } = {},
): Promise<TestSetup> {
  const sessionRepo = new InMemoryPluginSessionRepository();
  const calendarClient = new FakeCalendarClient();
  const detail = opts.eventDetail === undefined ? fullDetail() : opts.eventDetail;
  if (detail) {
    calendarClient.eventStore.set(detail.eventId, detail);
  }
  const geminiClient = new FakeGeminiClient();
  const token = await createSession(sessionRepo, sessionOverrides);
  const app = createTestApp({
    pluginSessionRepo: sessionRepo,
    pluginRateLimitRepo: new InMemoryPluginRateLimitRepository(),
    pluginRequestDedupeRepo: new InMemoryPluginRequestDedupeRepository(),
    resolveCalendarService: opts.resolveCalendarService ?? (async () => createCalendarService(calendarClient)),
    geminiClient,
    clock: fixedClock(NOW),
    ...(opts.geminiTimeoutMs !== undefined ? { geminiTimeoutMs: opts.geminiTimeoutMs } : {}),
  });
  return { app, sessionRepo, calendarClient, geminiClient, token };
}

/** headerOverridesにキーが存在する場合(値がundefinedでも)、そのヘッダーの既定値設定を上書き/省略する。 */
function postEditAudio(
  app: ReturnType<typeof createTestApp>,
  token: string,
  body: Buffer,
  headerOverrides: Record<string, string | undefined> = {},
) {
  const req = request(app)
    .post('/plugin/analyze-edit-audio')
    .set('Content-Type', 'audio/wav')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Install-Id', INSTALL_ID)
    .set('X-Request-Id', REQUEST_ID);
  if (!('X-Event-Id' in headerOverrides)) {
    req.set('X-Event-Id', EVENT_ID);
  }
  for (const [key, value] of Object.entries(headerOverrides)) {
    if (value === undefined) continue;
    req.set(key, value);
  }
  return req.send(body);
}

describe('OPTIONS /plugin/analyze-edit-audio (CORS preflight)', () => {
  it('responds 204 with scoped CORS headers including X-Event-Id', async () => {
    const { app } = await setup();
    const res = await request(app).options('/plugin/analyze-edit-audio');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('X-Event-Id');
  });
});

describe('POST /plugin/analyze-edit-audio success paths', () => {
  it('changes the title only', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', title: '定例会議' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.requestId).toBe(REQUEST_ID);
    expect(res.body.result.resultType).toBe('edit');
    expect(res.body.result.fields).toEqual({ title: '定例会議' });
  });

  it('changes the start time only, leaving end untouched', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', startLocal: '2026-07-23T14:30:00' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.fields).toEqual({ startLocal: '2026-07-23T14:30:00' });
    expect(res.body.result.fields).not.toHaveProperty('endLocal');
  });

  it('changes the end time only, leaving start untouched', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', endLocal: '2026-07-23T17:00:00' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.fields).toEqual({ endLocal: '2026-07-23T17:00:00' });
    expect(res.body.result.fields).not.toHaveProperty('startLocal');
  });

  it('changes start and end together', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({
      resultType: 'edit',
      startLocal: '2026-07-24T09:00:00',
      endLocal: '2026-07-24T10:00:00',
    });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.fields).toEqual({ startLocal: '2026-07-24T09:00:00', endLocal: '2026-07-24T10:00:00' });
  });

  it('changes the location', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', location: '会議室A' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.fields).toEqual({ location: '会議室A' });
  });

  it('changes the description', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', description: '資料を持参' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.fields).toEqual({ description: '資料を持参' });
  });

  it('deletes the description via an explicit empty string (distinct from omission = unchanged)', async () => {
    const { app, token, geminiClient, calendarClient } = await setup();
    calendarClient.eventStore.set(EVENT_ID, fullDetail({ description: '既存の説明' }));
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', description: '' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.fields).toEqual({ description: '' });
  });

  it('omits unspecified fields entirely from the response', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', title: '定例会議' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.result.fields)).toEqual(['title']);
  });

  it('moves the meeting 30 minutes later (Gemini resolves the relative instruction to absolute times)', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({
      resultType: 'edit',
      startLocal: '2026-07-23T15:30:00',
      endLocal: '2026-07-23T16:30:00',
    });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.fields).toEqual({ startLocal: '2026-07-23T15:30:00', endLocal: '2026-07-23T16:30:00' });
  });

  it('extends the end time by 1 hour', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', endLocal: '2026-07-23T17:00:00' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.fields).toEqual({ endLocal: '2026-07-23T17:00:00' });
  });

  it('preserves an all-day event as all-day when only the title changes', async () => {
    const { app, token, geminiClient, calendarClient } = await setup();
    calendarClient.eventStore.set(
      EVENT_ID,
      fullDetail({ startDateTime: null, endDateTime: null, startDate: '2026-07-23', endDate: '2026-07-24' }),
    );
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', title: '休暇' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.fields).toEqual({ title: '休暇' });
  });

  it('calls the Gemini client exactly once', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', title: '定例会議' });
    await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(geminiClient.editCalls).toHaveLength(1);
  });

  it('never mutates the calendar (no patch/delete/insert calls)', async () => {
    const { app, token, geminiClient, calendarClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', title: '定例会議' });
    await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(calendarClient.patchCallCount).toBe(0);
    expect(calendarClient.deleteCallCount).toBe(0);
    expect(calendarClient.getEventDetailCallCount).toBe(1);
  });
});

describe('POST /plugin/analyze-edit-audio not_understood paths', () => {
  it('rejects a change that would make start >= end', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', startLocal: '2026-07-23T18:00:00' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('not_understood');
    expect(res.body.result).not.toHaveProperty('fields');
  });

  it('returns not_understood for an ambiguous instruction', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'not_understood' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('not_understood');
  });

  it('detects a no-op instruction (proposed values identical to current values)', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', title: '打ち合わせ' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('not_understood');
  });

  it('rejects switching to all-day without a matching date range (unsupported change)', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', allDay: true });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('not_understood');
  });
});

describe('POST /plugin/analyze-edit-audio authentication/authorization', () => {
  it('returns 401 when Authorization is missing', async () => {
    const { app } = await setup();
    const res = await request(app)
      .post('/plugin/analyze-edit-audio')
      .set('Content-Type', 'audio/wav')
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID)
      .set('X-Event-Id', EVENT_ID)
      .send(buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when the session scope does not include audio:analyze', async () => {
    const { app, token } = await setup({ scope: ['calendar:read'] });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(403);
  });

  it('returns 401 for a revoked session', async () => {
    const { app, token } = await setup({ revoked: true });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(401);
  });
});

describe('POST /plugin/analyze-edit-audio request validation', () => {
  it('returns 400 when X-Event-Id is missing', async () => {
    const { app, token } = await setup();
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }), { 'X-Event-Id': undefined });
    expect(res.status).toBe(400);
  });

  it('returns 400 when X-Event-Id is malformed', async () => {
    const { app, token } = await setup();
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }), { 'X-Event-Id': '!!' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the event does not exist', async () => {
    const { app, token } = await setup({}, { eventDetail: null });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(404);
  });

  it('returns 403 when Calendar is not connected (resolveCalendarService returns null)', async () => {
    const { app, token } = await setup({}, { resolveCalendarService: async () => null });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(403);
  });

  it('rejects too-short audio', async () => {
    const { app, token } = await setup();
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 0.1 }));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid WAV (bad RIFF header)', async () => {
    const { app, token } = await setup();
    const bogus = Buffer.alloc(20_000, 0);
    const res = await postEditAudio(app, token, bogus);
    expect(res.status).toBe(400);
  });

  it('does not call Gemini when the WAV is invalid', async () => {
    const { app, token, geminiClient } = await setup();
    await postEditAudio(app, token, buildWav({ durationSeconds: 0.1 }));
    expect(geminiClient.editCalls).toHaveLength(0);
  });
});

describe('POST /plugin/analyze-edit-audio model-failure handling', () => {
  it('returns 502 when Gemini throws', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.shouldThrow = new Error('network boom');
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(502);
  });

  it('handles a Gemini timeout safely with a sanitized 504 response (no crash)', async () => {
    const { app, token, geminiClient } = await setup({}, { geminiTimeoutMs: 50 });
    geminiClient.abortOnCall = true;
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(504);
    expect(JSON.stringify(res.body)).not.toMatch(/AbortError|stack/i);
  });

  it('returns 502 for malformed (non-JSON) model output', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = 'not valid json{{{';
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(502);
  });

  it('returns 502 for JSON with an unknown/undefined top-level field', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = JSON.stringify({ ...JSON.parse(editInstructionJson()), transcription: 'secret text' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(502);
  });

  it('returns 502 when the schema is violated (invalid resultType enum)', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = JSON.stringify({ ...JSON.parse(editInstructionJson()), resultType: 'garbage' });
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(502);
  });
});

describe('POST /plugin/analyze-edit-audio privacy: no sensitive logs', () => {
  it('never logs the session token, install id, event id, title, or date/time content', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = editInstructionJson({ resultType: 'edit', title: 'UNIQUE_SENTINEL_TITLE' });

    await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));

    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain(token);
    expect(allLogText).not.toContain(INSTALL_ID);
    expect(allLogText).not.toContain(EVENT_ID);
    expect(allLogText).not.toContain('UNIQUE_SENTINEL_TITLE');
    expect(allLogText).not.toContain('2026-07-23T15:00:00');
    logSpy.mockRestore();
  });

  it('never logs the raw Gemini response text, audio bytes, or transcription content', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = 'garbage-with-marker-ABCXYZ';

    await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));

    const allText = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(allText).not.toContain('ABCXYZ');
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('does not expose the raw model response or internal error details in the error body', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.editResponseJson = 'not valid json with secret marker XYZZY';
    const res = await postEditAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(JSON.stringify(res.body)).not.toContain('XYZZY');
  });
});
