import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';
import { InMemoryPluginSessionRepository, type PluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { InMemoryPluginRateLimitRepository } from '../src/firestore/pluginRateLimitRepository.js';
import { InMemoryPluginRequestDedupeRepository } from '../src/firestore/pluginRequestDedupeRepository.js';
import { InMemoryPluginEventCandidateRepository } from '../src/firestore/pluginEventCandidateRepository.js';
import { InMemoryPluginConversationRepository } from '../src/firestore/pluginConversationRepository.js';
import { FakeGeminiClient } from '../src/gemini/geminiClient.js';
import { generateDevSessionToken, hashDevSessionToken } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';
import { buildWav } from './helpers/buildWav.js';

const INSTALL_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-07-22T05:00:00Z'); // 2026-07-22 14:00 JST

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

/** Gemini生JSON(fragment形式)を組み立てる。既定は完成した予定候補(明日は2026-07-23)。 */
function eventCandidateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: '1',
    resultType: 'event_candidate',
    title: '打ち合わせ',
    dateLocal: '2026-07-23',
    startTimeLocal: '15:00:00',
    durationMinutes: 60,
    timeZone: 'Asia/Tokyo',
    allDay: false,
    explicitCorrection: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions: [],
    ...overrides,
  });
}

interface TestSetup {
  app: ReturnType<typeof createTestApp>;
  sessionRepo: PluginSessionRepository;
  candidateRepo: InMemoryPluginEventCandidateRepository;
  conversationRepo: InMemoryPluginConversationRepository;
  geminiClient: FakeGeminiClient;
  token: string;
}

async function setup(sessionOverrides: Parameters<typeof createSession>[1] = {}): Promise<TestSetup> {
  const sessionRepo = new InMemoryPluginSessionRepository();
  const candidateRepo = new InMemoryPluginEventCandidateRepository();
  const conversationRepo = new InMemoryPluginConversationRepository();
  const geminiClient = new FakeGeminiClient();
  const token = await createSession(sessionRepo, sessionOverrides);
  const app = createTestApp({
    pluginSessionRepo: sessionRepo,
    pluginRateLimitRepo: new InMemoryPluginRateLimitRepository(),
    pluginRequestDedupeRepo: new InMemoryPluginRequestDedupeRepository(),
    pluginEventCandidateRepo: candidateRepo,
    pluginConversationRepo: conversationRepo,
    geminiClient,
    clock: fixedClock(NOW),
  });
  return { app, sessionRepo, candidateRepo, conversationRepo, geminiClient, token };
}

function postAudio(app: ReturnType<typeof createTestApp>, token: string, body: Buffer, headerOverrides: Record<string, string> = {}) {
  const req = request(app)
    .post('/plugin/analyze-audio')
    .set('Content-Type', 'audio/wav')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Install-Id', INSTALL_ID)
    .set('X-Request-Id', REQUEST_ID);
  for (const [key, value] of Object.entries(headerOverrides)) {
    req.set(key, value);
  }
  return req.send(body);
}

describe('OPTIONS /plugin/analyze-audio (CORS preflight)', () => {
  it('responds 204 with scoped CORS headers', async () => {
    const { app } = await setup();
    const res = await request(app).options('/plugin/analyze-audio');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('X-Request-Id');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not leak CORS headers onto unrelated routes', async () => {
    const { app } = await setup();
    const res = await request(app).get('/health');
    // /health has its own separate CORS scoping; this just confirms analyze-audio's
    // Access-Control-Allow-Headers (with X-Install-Id/X-Request-Id) isn't present there.
    expect(res.headers['access-control-allow-headers']).toBeUndefined();
  });
});

describe('POST /plugin/analyze-audio success paths', () => {
  it('returns 200 with an event_candidate result', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = eventCandidateJson();

    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.requestId).toBe(REQUEST_ID);
    expect(res.body.result.resultType).toBe('event_candidate');
    expect(res.body.result.title).toBe('打ち合わせ');
    expect(res.body.result.startLocal).toBe('2026-07-23T15:00:00');
    expect(res.body.result.endLocal).toBe('2026-07-23T16:00:00');
  });

  it('calls the Gemini client exactly once', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = eventCandidateJson();
    await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(geminiClient.calls).toHaveLength(1);
  });

  it('applies duration_defaulted when Gemini omits durationMinutes and the server defaults 60 minutes', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = eventCandidateJson({ durationMinutes: null });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('event_candidate');
    expect(res.body.result.endLocal).toBe('2026-07-23T16:00:00');
    expect(res.body.result.assumptions).toContain('duration_defaulted');
  });

  it('returns needs_clarification when title/date are known but start time is missing', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'needs_clarification',
      dateLocal: '2026-07-23',
      startTimeLocal: null,
      durationMinutes: null,
      clarificationQuestion: '何時からですか?',
    });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('needs_clarification');
    expect(res.body.result.clarificationField).toBe('start_time');
  });

  it('returns not_calendar_request results as-is', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'not_calendar_request',
      title: null,
      dateLocal: null,
      startTimeLocal: null,
      durationMinutes: null,
    });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('not_calendar_request');
  });

  it('downgrades a past-dated event_candidate to needs_clarification (temporal safety net)', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = eventCandidateJson({ dateLocal: '2020-01-01', startTimeLocal: '10:00:00', durationMinutes: 60 });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('needs_clarification');
  });

  it('never includes a transcription-shaped field in the response', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = JSON.stringify({
      ...JSON.parse(eventCandidateJson()),
      transcription: '明日の午後3時から1時間、打ち合わせ',
    });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(200);
    expect(res.body.result).not.toHaveProperty('transcription');
    expect(JSON.stringify(res.body)).not.toContain('明日の午後3時');
  });

  it('sets Cache-Control: no-store and X-Content-Type-Options: nosniff', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = eventCandidateJson();
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('POST /plugin/analyze-audio authentication/authorization', () => {
  it('returns 401 when Authorization is missing', async () => {
    const { app } = await setup();
    const res = await request(app)
      .post('/plugin/analyze-audio')
      .set('Content-Type', 'audio/wav')
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID)
      .send(buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const { app } = await setup();
    const res = await postAudio(app, 'not-a-real-token', buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired session', async () => {
    const { app, token } = await setup({ expiresAt: new Date(NOW.getTime() - 1000) });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(401);
  });

  it('returns 401 for a revoked session', async () => {
    const { app, token } = await setup({ revoked: true });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when X-Install-Id does not match the session', async () => {
    const { app, token } = await setup({ installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(403);
  });

  it('returns 403 when the session scope does not include audio:analyze', async () => {
    const { app, token } = await setup({ scope: ['something:else'] });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(403);
  });

  it('does not leak which specific check failed in the error body', async () => {
    const { app, token } = await setup({ revoked: true });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(JSON.stringify(res.body)).not.toMatch(/revoked|expired|installId|scope/i);
  });
});

describe('POST /plugin/analyze-audio request validation', () => {
  it('returns 415 for a non-audio/wav Content-Type', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .post('/plugin/analyze-audio')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID)
      .send(JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(415);
  });

  it('returns 400 for an empty body', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .post('/plugin/analyze-audio')
      .set('Content-Type', 'audio/wav')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID)
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('returns 400 when X-Install-Id is missing', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .post('/plugin/analyze-audio')
      .set('Content-Type', 'audio/wav')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', REQUEST_ID)
      .send(buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when X-Request-Id is missing', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .post('/plugin/analyze-audio')
      .set('Content-Type', 'audio/wav')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .send(buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when X-Request-Id is not a UUID', async () => {
    const { app, token } = await setup();
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }), { 'X-Request-Id': 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid WAV structure (bad RIFF header)', async () => {
    const { app, token } = await setup();
    const buf = buildWav({ durationSeconds: 2 });
    buf.write('XXXX', 0, 'ascii');
    const res = await postAudio(app, token, buf);
    expect(res.status).toBe(400);
  });

  it('returns 400 for stereo audio', async () => {
    const { app, token } = await setup();
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2, numChannels: 2 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for the wrong sample rate', async () => {
    const { app, token } = await setup();
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2, sampleRate: 8000 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for the wrong bit depth', async () => {
    const { app, token } = await setup();
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2, bitsPerSample: 8 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for audio below the minimum size', async () => {
    const { app, token } = await setup();
    const res = await postAudio(app, token, buildWav({ durationSeconds: 0.01 }));
    expect(res.status).toBe(400);
  });

  it('returns 413 when the body exceeds the byte-stream limit regardless of Content-Length', async () => {
    const { app, token } = await setup();
    const res = await postAudio(app, token, buildWav({ durationSeconds: 40 }));
    expect(res.status).toBe(413);
  });

  it('does not call Gemini when WAV validation fails', async () => {
    const { app, token, geminiClient } = await setup();
    await postAudio(app, token, buildWav({ durationSeconds: 2, numChannels: 2 }));
    expect(geminiClient.calls).toHaveLength(0);
  });
});

describe('POST /plugin/analyze-audio idempotency', () => {
  it('returns 409 for a duplicate (session, installId, requestId)', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = eventCandidateJson();

    const first = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(first.status).toBe(200);

    const second = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(second.status).toBe(409);
    // Geminiは1回しか呼ばれていないはず(重複時は再度呼ばない)
    expect(geminiClient.calls).toHaveLength(1);
  });

  it('treats the same requestId as duplicate even after a failed first attempt (no auto-retry)', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.shouldThrow = new Error('boom');

    const first = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(first.status).toBe(502);

    const second = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(second.status).toBe(409);
    expect(geminiClient.calls).toHaveLength(1);
  });

  it('allows a different requestId from the same session to proceed normally', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = eventCandidateJson();

    const first = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(first.status).toBe(200);

    const second = await postAudio(app, token, buildWav({ durationSeconds: 2 }), {
      'X-Request-Id': '44444444-4444-4444-8444-444444444444',
    });
    expect(second.status).toBe(200);
    expect(geminiClient.calls).toHaveLength(2);
  });
});

describe('POST /plugin/analyze-audio rate limiting', () => {
  it('returns 429 with Retry-After once the per-minute limit is exceeded', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const geminiClient = new FakeGeminiClient();
    geminiClient.responseJson = eventCandidateJson();
    const token = await createSession(sessionRepo);
    const app = createTestApp({
      pluginSessionRepo: sessionRepo,
      pluginRateLimitRepo: new InMemoryPluginRateLimitRepository(),
      pluginRequestDedupeRepo: new InMemoryPluginRequestDedupeRepository(),
      geminiClient,
      clock: fixedClock(NOW),
    });

    for (let i = 0; i < 10; i += 1) {
      const res = await postAudio(app, token, buildWav({ durationSeconds: 1 }), {
        'X-Request-Id': `55555555-5555-4555-8555-55555555555${i}`,
      });
      expect(res.status).toBe(200);
    }

    const eleventh = await postAudio(app, token, buildWav({ durationSeconds: 1 }), {
      'X-Request-Id': '66666666-6666-4666-8666-666666666666',
    });
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers['retry-after']).toBeDefined();
  });
});

describe('POST /plugin/analyze-audio Gemini failure handling', () => {
  it('returns 504 when Gemini times out', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const geminiClient = new FakeGeminiClient();
    geminiClient.abortOnCall = true;
    const token = await createSession(sessionRepo);
    const app = createTestApp({
      pluginSessionRepo: sessionRepo,
      pluginRateLimitRepo: new InMemoryPluginRateLimitRepository(),
      pluginRequestDedupeRepo: new InMemoryPluginRequestDedupeRepository(),
      geminiClient,
      clock: fixedClock(NOW),
      geminiTimeoutMs: 50,
    });

    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(504);
  });

  it('returns 502 when Gemini throws', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.shouldThrow = new Error('network boom');
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(502);
  });

  it('returns 502 for malformed (non-JSON) model output', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = 'not valid json{{{';
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(502);
  });

  it('returns 502 for JSON that does not satisfy the schema', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = JSON.stringify({ foo: 'bar' });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(502);
  });

  it('returns 502 when the model returns an undefined/empty response', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = undefined;
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(502);
  });

  it('does not expose the raw model response or internal error details in the error body', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = 'not valid json with secret marker XYZZY';
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(JSON.stringify(res.body)).not.toContain('XYZZY');
  });
});

describe('POST /plugin/analyze-audio privacy: no persistence, no sensitive logs', () => {
  it('never stores audio bytes or Gemini results in any repository', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const dedupeRepo = new InMemoryPluginRequestDedupeRepository();
    const geminiClient = new FakeGeminiClient();
    geminiClient.responseJson = eventCandidateJson({ title: 'UNIQUE_SENTINEL_TITLE' });
    const token = await createSession(sessionRepo);
    const app = createTestApp({
      pluginSessionRepo: sessionRepo,
      pluginRateLimitRepo: new InMemoryPluginRateLimitRepository(),
      pluginRequestDedupeRepo: dedupeRepo,
      geminiClient,
      clock: fixedClock(NOW),
    });

    await postAudio(app, token, buildWav({ durationSeconds: 2 }));

    const stored = dedupeRepo.entries();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('completed');
    // 保存内容全体をシリアライズしても、タイトル・音声・結果本体が一切含まれないことを確認する
    expect(JSON.stringify(stored)).not.toContain('UNIQUE_SENTINEL_TITLE');
    expect(Object.keys(stored[0] ?? {}).sort()).toEqual(['createdAt', 'expiresAt', 'requestKeyHash', 'status', 'updatedAt']);
  });

  it('never logs the session token, install id, title, or date/time content', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = eventCandidateJson({ title: 'UNIQUE_SENTINEL_TITLE', clarificationQuestion: null });

    await postAudio(app, token, buildWav({ durationSeconds: 2 }));

    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain(token);
    expect(allLogText).not.toContain(INSTALL_ID);
    expect(allLogText).not.toContain('UNIQUE_SENTINEL_TITLE');
    expect(allLogText).not.toContain('2026-07-23T15:00:00');
    logSpy.mockRestore();
  });

  it('never logs the raw Gemini response text', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, token, geminiClient } = await setup();
    geminiClient.responseJson = 'garbage-with-marker-ABCXYZ';

    await postAudio(app, token, buildWav({ durationSeconds: 2 }));

    const allText = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(allText).not.toContain('ABCXYZ');
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('POST /plugin/analyze-audio candidate storage (Phase 2D)', () => {
  it('stores a candidate and includes candidateId in the response for event_candidate', async () => {
    const { app, token, geminiClient, candidateRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson();

    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(typeof res.body.candidateId).toBe('string');
    const doc = await candidateRepo.get(res.body.candidateId as string);
    expect(doc).not.toBeNull();
    expect(doc?.status).toBe('pending');
    expect(doc?.title).toBe('打ち合わせ');
  });

  it('does not store a candidate and returns candidateId=null for needs_clarification', async () => {
    const { app, token, geminiClient, candidateRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'needs_clarification',
      title: null,
      dateLocal: null,
      startTimeLocal: null,
      durationMinutes: null,
    });

    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.candidateId).toBeNull();
    expect(candidateRepo.entriesForTest()).toHaveLength(0);
  });

  it('does not store a candidate and returns candidateId=null for not_calendar_request', async () => {
    const { app, token, geminiClient, candidateRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'not_calendar_request',
      title: null,
      dateLocal: null,
      startTimeLocal: null,
      durationMinutes: null,
    });

    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.candidateId).toBeNull();
    expect(candidateRepo.entriesForTest()).toHaveLength(0);
  });

  it('gives the candidate a 10-minute TTL', async () => {
    const { app, token, geminiClient, candidateRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson();

    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    const doc = await candidateRepo.get(res.body.candidateId as string);

    expect(doc?.expiresAt.getTime()).toBe(NOW.getTime() + 10 * 60 * 1000);
  });

  it('binds the candidate to the session and installId (hashed, not raw)', async () => {
    const { app, token, geminiClient, candidateRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson();

    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    const doc = await candidateRepo.get(res.body.candidateId as string);

    expect(doc?.sessionHash).not.toBe(token);
    expect(doc?.installIdHash).not.toBe(INSTALL_ID);
    expect(JSON.stringify(doc)).not.toContain(token);
    expect(JSON.stringify(doc)).not.toContain(INSTALL_ID);
  });

  it('never stores audio, WAV, or transcription content in the candidate document', async () => {
    const { app, token, geminiClient, candidateRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson({ title: 'UNIQUE_SENTINEL_TITLE_FOR_FIELD_CHECK' });

    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    const doc = await candidateRepo.get(res.body.candidateId as string);
    const keys = Object.keys(doc ?? {});

    expect(keys).not.toContain('audio');
    expect(keys).not.toContain('wav');
    expect(keys).not.toContain('pcm');
    expect(keys).not.toContain('transcription');
  });
});

describe('POST /plugin/analyze-audio conversation creation (Phase 2E)', () => {
  it('creates a conversation and includes conversationId/turn=1/maxTurns=3 for needs_clarification', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'needs_clarification',
      startTimeLocal: null,
      durationMinutes: null,
    });

    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(typeof res.body.conversationId).toBe('string');
    expect(res.body.turn).toBe(1);
    expect(res.body.maxTurns).toBe(3);

    const doc = await conversationRepo.get(res.body.conversationId as string);
    expect(doc?.status).toBe('awaiting_clarification');
    expect(doc?.missingField).toBe('start_time');
  });

  it('does not create a conversation for event_candidate', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson();
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.body.conversationId).toBeNull();
    expect(res.body.turn).toBeNull();
    expect(res.body.maxTurns).toBeNull();
    expect(conversationRepo.entriesForTest()).toHaveLength(0);
  });

  it('does not create a conversation for not_calendar_request', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'not_calendar_request',
      title: null,
      dateLocal: null,
      startTimeLocal: null,
      durationMinutes: null,
    });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.body.conversationId).toBeNull();
    expect(conversationRepo.entriesForTest()).toHaveLength(0);
  });

  it('cancels a prior active conversation for the same session when starting a new one', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'needs_clarification',
      startTimeLocal: null,
      durationMinutes: null,
    });

    const first = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    const firstConversationId = first.body.conversationId as string;

    const second = await postAudio(app, token, buildWav({ durationSeconds: 2 }), { 'X-Request-Id': '55555555-5555-4555-8555-555555555555' });
    const secondConversationId = second.body.conversationId as string;

    expect(firstConversationId).not.toBe(secondConversationId);
    const firstDoc = await conversationRepo.get(firstConversationId);
    expect(firstDoc?.status).toBe('cancelled');
    const secondDoc = await conversationRepo.get(secondConversationId);
    expect(secondDoc?.status).toBe('awaiting_clarification');
  });

  it('gives the conversation a 10-minute TTL', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'needs_clarification',
      title: null,
      dateLocal: null,
      startTimeLocal: null,
      durationMinutes: null,
    });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    const doc = await conversationRepo.get(res.body.conversationId as string);
    expect(doc?.expiresAt.getTime()).toBe(NOW.getTime() + 10 * 60 * 1000);
  });

  it('binds the conversation to the session and installId (hashed, not raw)', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'needs_clarification',
      title: null,
      dateLocal: null,
      startTimeLocal: null,
      durationMinutes: null,
    });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    const doc = await conversationRepo.get(res.body.conversationId as string);
    expect(doc?.sessionHash).not.toBe(token);
    expect(doc?.installIdHash).not.toBe(INSTALL_ID);
  });

  it('never stores the clarification question text, only the missingField enum', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'needs_clarification',
      title: null,
      dateLocal: null,
      startTimeLocal: null,
      durationMinutes: null,
      clarificationQuestion: 'UNIQUE_QUESTION_TEXT',
    });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    const doc = await conversationRepo.get(res.body.conversationId as string);
    expect(JSON.stringify(doc)).not.toContain('UNIQUE_QUESTION_TEXT');
  });

  it('does not ask "is this today?" when the date is already known (fragment regression for the real-device date-loss bug)', async () => {
    // 明日、打ち合わせ: title/dateLocalは判明、start_timeのみ不明という初回応答を再現する。
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.responseJson = eventCandidateJson({
      resultType: 'needs_clarification',
      dateLocal: '2026-07-23',
      startTimeLocal: null,
      durationMinutes: null,
    });
    const res = await postAudio(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.body.result.clarificationField).toBe('start_time');
    const doc = await conversationRepo.get(res.body.conversationId as string);
    expect(doc?.partialCandidate.dateLocal).toBe('2026-07-23');
    expect(doc?.missingField).toBe('start_time');
  });
});
