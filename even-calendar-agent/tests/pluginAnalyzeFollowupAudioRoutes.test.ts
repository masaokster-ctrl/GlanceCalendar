import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';
import { InMemoryPluginSessionRepository, type PluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { InMemoryPluginRequestDedupeRepository } from '../src/firestore/pluginRequestDedupeRepository.js';
import { InMemoryPluginEventCandidateRepository } from '../src/firestore/pluginEventCandidateRepository.js';
import {
  InMemoryPluginConversationRepository,
  MAX_TURNS,
  type PluginConversationRepository,
} from '../src/firestore/pluginConversationRepository.js';
import type { PartialCandidate } from '../src/firestore/models.js';
import { FakeGeminiClient } from '../src/gemini/geminiClient.js';
import { generateDevSessionToken, hashDevSessionToken, hashValue } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';
import { buildWav } from './helpers/buildWav.js';

const INSTALL_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-07-22T05:00:00Z'); // 2026-07-22 14:00 JST

async function createSession(repo: PluginSessionRepository, overrides: { installId?: string } = {}): Promise<string> {
  const token = generateDevSessionToken();
  await repo.create({
    tokenHash: hashDevSessionToken(token),
    installId: overrides.installId ?? INSTALL_ID,
    scope: ['audio:analyze', 'calendar:create', 'calendar:status'],
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
  });
  return token;
}

/** 既定: title/dateLocal既知、startTimeLocalのみ不足(missingField=start_time)という一番よく使うケース。 */
function defaultPartialCandidate(overrides: Partial<PartialCandidate> = {}): PartialCandidate {
  return {
    title: '打ち合わせ',
    dateLocal: '2026-07-23',
    startTimeLocal: null,
    durationMinutes: null,
    startLocal: null,
    endLocal: null,
    timeZone: 'Asia/Tokyo',
    allDay: false,
    endDateLocal: null,
    allDaySignal: null,
    ...overrides,
  };
}

async function createConversation(
  repo: PluginConversationRepository,
  token: string,
  overrides: Partial<{
    expiresAt: Date;
    turnCount: number;
    status: 'awaiting_clarification' | 'completed' | 'cancelled';
    partialCandidate: PartialCandidate;
    missingField: 'title' | 'date' | 'start_time' | 'duration' | 'multiple';
  }> = {},
): Promise<void> {
  const tokenHash = hashDevSessionToken(token);
  await repo.create({
    conversationId: CONVERSATION_ID,
    sessionHash: tokenHash,
    installIdHash: hashValue(INSTALL_ID),
    partialCandidate: overrides.partialCandidate ?? defaultPartialCandidate(),
    missingField: overrides.missingField ?? 'start_time',
    now: NOW,
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 10 * 60 * 1000),
  });
  for (let i = 0; i < (overrides.turnCount ?? 0); i += 1) {
    await repo.recordNextClarification({
      conversationId: CONVERSATION_ID,
      partialCandidate: overrides.partialCandidate ?? defaultPartialCandidate(),
      missingField: overrides.missingField ?? 'start_time',
      now: NOW,
    });
  }
  if (overrides.status === 'completed') await repo.markCompleted(CONVERSATION_ID, NOW);
  if (overrides.status === 'cancelled') await repo.markCancelled(CONVERSATION_ID, NOW);
}

/** Gemini follow-up生JSON(fragment形式)。既定は"開始時刻の回答"(startTimeLocalのみを供給)。 */
function followupResultJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: '1',
    resultType: 'event_candidate',
    title: null,
    dateLocal: null,
    startTimeLocal: '15:00:00',
    durationMinutes: null,
    timeZone: 'Asia/Tokyo',
    allDay: false,
    explicitCorrection: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions: [],
    ...overrides,
  });
}

interface Setup {
  app: ReturnType<typeof createTestApp>;
  sessionRepo: PluginSessionRepository;
  conversationRepo: PluginConversationRepository;
  geminiClient: FakeGeminiClient;
  token: string;
}

async function setup(
  conversationOverrides: Parameters<typeof createConversation>[2] = {},
  sessionOverrides: Parameters<typeof createSession>[1] = {},
): Promise<Setup> {
  const sessionRepo = new InMemoryPluginSessionRepository();
  const conversationRepo = new InMemoryPluginConversationRepository();
  const geminiClient = new FakeGeminiClient();
  const token = await createSession(sessionRepo, sessionOverrides);
  await createConversation(conversationRepo, token, conversationOverrides);
  const app = createTestApp({
    pluginSessionRepo: sessionRepo,
    pluginConversationRepo: conversationRepo,
    pluginRequestDedupeRepo: new InMemoryPluginRequestDedupeRepository(),
    pluginEventCandidateRepo: new InMemoryPluginEventCandidateRepository(),
    geminiClient,
    clock: fixedClock(NOW),
  });
  return { app, sessionRepo, conversationRepo, geminiClient, token };
}

function postFollowup(
  app: ReturnType<typeof createTestApp>,
  token: string,
  body: Buffer,
  headerOverrides: Record<string, string> = {},
) {
  const req = request(app)
    .post('/plugin/analyze-followup-audio')
    .set('Content-Type', 'audio/wav')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Install-Id', INSTALL_ID)
    .set('X-Request-Id', REQUEST_ID)
    .set('X-Conversation-Id', CONVERSATION_ID);
  for (const [k, v] of Object.entries(headerOverrides)) req.set(k, v);
  return req.send(body);
}

describe('OPTIONS /plugin/analyze-followup-audio (CORS preflight)', () => {
  it('responds 204 with scoped CORS headers including X-Conversation-Id', async () => {
    const { app } = await setup();
    const res = await request(app).options('/plugin/analyze-followup-audio');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toContain('X-Conversation-Id');
  });
});

describe('POST /plugin/analyze-followup-audio success paths', () => {
  it('completes the candidate and returns candidateId when the follow-up supplies the missing start time', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.followupResponseJson = followupResultJson();

    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('event_candidate');
    expect(res.body.result.title).toBe('打ち合わせ');
    expect(res.body.result.startLocal).toBe('2026-07-23T15:00:00');
    expect(res.body.result.endLocal).toBe('2026-07-23T16:00:00');
    expect(res.body.result.assumptions).toContain('duration_defaulted');
    expect(typeof res.body.candidateId).toBe('string');
    expect(res.body.turn).toBeNull();
  });

  it('marks the conversation completed after event_candidate', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.followupResponseJson = followupResultJson();
    await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(doc?.status).toBe('completed');
  });

  it('calls the follow-up Gemini method exactly once (distinct from generateEventCandidateJson)', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.followupResponseJson = followupResultJson();
    await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(geminiClient.followupCalls).toHaveLength(1);
    expect(geminiClient.calls).toHaveLength(0);
  });

  it('does not ask "is this today?" when dateLocal is already known (regression for the real-device date-loss bug)', async () => {
    // 実機不具合の再現: 「明日、打ち合わせ」→「何時からですか?」→「午後3時」で
    // 誤ってclarificationField='date'相当の再質問が返っていた。dateLocalが既知ならサーバーが
    // Geminiの申告を無視して完成させることを確認する。
    const { app, token, geminiClient } = await setup();
    geminiClient.followupResponseJson = followupResultJson({ startTimeLocal: '15:00:00', clarificationField: 'date' });

    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('event_candidate');
    expect(res.body.result.startLocal).toBe('2026-07-23T15:00:00');
  });

  it('asks a second clarification question when still incomplete, incrementing turn', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.followupResponseJson = followupResultJson({
      resultType: 'needs_clarification',
      startTimeLocal: null,
      clarificationQuestion: 'もう一度教えてください',
    });

    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('needs_clarification');
    expect(res.body.turn).toBe(2);
    expect(res.body.maxTurns).toBe(MAX_TURNS);

    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(doc?.status).toBe('awaiting_clarification');
    expect(doc?.turnCount).toBe(1);
    expect(doc?.missingField).toBe('start_time');
  });

  it('follow-up "date only" completes when title/startTimeLocal were already known', async () => {
    const { app, token, geminiClient } = await setup({
      partialCandidate: defaultPartialCandidate({ dateLocal: null, startTimeLocal: '15:00:00' }),
      missingField: 'date',
    });
    geminiClient.followupResponseJson = followupResultJson({ startTimeLocal: null, dateLocal: '2026-07-23' });

    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('event_candidate');
    expect(res.body.result.startLocal).toBe('2026-07-23T15:00:00');
  });

  it('follow-up "title only" completes when date/startTimeLocal were already known', async () => {
    const { app, token, geminiClient } = await setup({
      partialCandidate: defaultPartialCandidate({ title: null, dateLocal: '2026-07-23', startTimeLocal: '15:00:00' }),
      missingField: 'title',
    });
    geminiClient.followupResponseJson = followupResultJson({ startTimeLocal: null, title: '打ち合わせ' });

    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('event_candidate');
    expect(res.body.result.title).toBe('打ち合わせ');
    expect(res.body.result.startLocal).toBe('2026-07-23T15:00:00');
  });

  it('merges partial answers: a time-only answer fills in startLocal/endLocal while keeping the existing title', async () => {
    const { app, token, geminiClient } = await setup();
    // Geminiはtitleを返さない(答えていないので)が、既存のtitleが維持されるはず
    geminiClient.followupResponseJson = followupResultJson({ title: null });

    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.result.title).toBe('打ち合わせ');
  });

  it('does not overwrite a confirmed value when explicitCorrection is false, even if Gemini returns a different one', async () => {
    const { app, token, geminiClient } = await setup({
      partialCandidate: defaultPartialCandidate({ startTimeLocal: '10:00:00' }),
    });
    geminiClient.followupResponseJson = followupResultJson({ startTimeLocal: '15:00:00', explicitCorrection: false });
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.body.result.startLocal).toBe('2026-07-23T10:00:00');
  });

  it('allows an explicit correction to override a previously confirmed value', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.followupResponseJson = followupResultJson({ title: 'CORRECTED_TITLE', explicitCorrection: true });
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.body.result.title).toBe('CORRECTED_TITLE');
  });

  it('treats a cancel phrase as resultType=cancelled and does not create a candidate', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.followupResponseJson = followupResultJson({ resultType: 'cancelled' });

    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('cancelled');
    expect(res.body.candidateId).toBeNull();
    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(doc?.status).toBe('cancelled');
  });

  it('downgrades a past-dated completion via the temporal safety net (re-asks instead)', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.followupResponseJson = followupResultJson({
      dateLocal: '2020-01-01',
      startTimeLocal: '10:00:00',
      explicitCorrection: true,
    });
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.body.result.resultType).toBe('needs_clarification');
  });

  it('terminates as cancelled on the third turn if still incomplete (no fourth question)', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup({ turnCount: MAX_TURNS - 1 });
    geminiClient.followupResponseJson = followupResultJson({ resultType: 'needs_clarification', startTimeLocal: null });

    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe('cancelled');
    expect(res.body.turn).toBeNull();
    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(doc?.status).toBe('cancelled');
  });
});

describe('POST /plugin/analyze-followup-audio authentication/authorization', () => {
  it('returns 401 when Authorization is missing', async () => {
    const { app } = await setup();
    const res = await request(app)
      .post('/plugin/analyze-followup-audio')
      .set('Content-Type', 'audio/wav')
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID)
      .set('X-Conversation-Id', CONVERSATION_ID)
      .send(buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when X-Install-Id does not match the session', async () => {
    const { app, token } = await setup();
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }), { 'X-Install-Id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when the conversation belongs to a different session', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const conversationRepo = new InMemoryPluginConversationRepository();
    const token = await createSession(sessionRepo);
    await conversationRepo.create({
      conversationId: CONVERSATION_ID,
      sessionHash: 'someone-elses-hash',
      installIdHash: hashValue(INSTALL_ID),
      partialCandidate: defaultPartialCandidate(),
      missingField: 'start_time',
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 600_000),
    });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginConversationRepo: conversationRepo, clock: fixedClock(NOW) });
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(403);
  });
});

describe('POST /plugin/analyze-followup-audio request validation', () => {
  it('returns 415 for non-audio/wav Content-Type', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .post('/plugin/analyze-followup-audio')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID)
      .set('X-Conversation-Id', CONVERSATION_ID)
      .send('{}');
    expect(res.status).toBe(415);
  });

  it('returns 400 when X-Conversation-Id is missing', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .post('/plugin/analyze-followup-audio')
      .set('Content-Type', 'audio/wav')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .set('X-Request-Id', REQUEST_ID)
      .send(buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid WAV (wrong sample rate)', async () => {
    const { app, token } = await setup();
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2, sampleRate: 8000 }));
    expect(res.status).toBe(400);
  });

  it('returns 413 for oversized audio', async () => {
    const { app, token } = await setup();
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 40 }));
    expect(res.status).toBe(413);
  });

  it('does not call Gemini when WAV validation fails, and releases the lease back to awaiting_clarification', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    await postFollowup(app, token, buildWav({ durationSeconds: 2, sampleRate: 8000 }));
    expect(geminiClient.followupCalls).toHaveLength(0);
    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(doc?.status).toBe('awaiting_clarification');
    expect(doc?.turnCount).toBe(0);
  });
});

describe('POST /plugin/analyze-followup-audio conversation validation', () => {
  it('returns 410 for an unknown conversationId', async () => {
    const { app, token } = await setup();
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }), {
      'X-Conversation-Id': '99999999-9999-4999-8999-999999999999',
    });
    expect(res.status).toBe(410);
  });

  it('returns 410 for an expired conversation', async () => {
    const { app, token } = await setup({ expiresAt: new Date(NOW.getTime() - 1000) });
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(410);
  });

  it('returns 410 for an already-completed conversation', async () => {
    const { app, token } = await setup({ status: 'completed' });
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(410);
  });

  it('returns 410 for an already-cancelled conversation', async () => {
    const { app, token } = await setup({ status: 'cancelled' });
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(410);
  });

  it('returns 410 when turnCount already reached MAX_TURNS', async () => {
    const { app, token } = await setup({ turnCount: MAX_TURNS });
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(410);
  });
});

describe('POST /plugin/analyze-followup-audio idempotency and concurrency', () => {
  it('returns 409 for a duplicate X-Request-Id', async () => {
    const { app, token, geminiClient } = await setup();
    geminiClient.followupResponseJson = followupResultJson();

    const first = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(first.status).toBe(200);

    const second = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(second.status).toBe(409);
    expect(geminiClient.followupCalls).toHaveLength(1);
  });

  it('returns 409 when a concurrent request already holds the follow-up lease', async () => {
    const { app, token, conversationRepo } = await setup();
    await conversationRepo.acquireFollowupLease({
      conversationId: CONVERSATION_ID,
      leaseOwner: 'other-owner',
      leaseDurationMs: 30_000,
      now: NOW,
    });
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(409);
  });
});

describe('POST /plugin/analyze-followup-audio Gemini failure handling (rollback)', () => {
  it('releases the lease back to awaiting_clarification without incrementing turnCount on Gemini failure', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.shouldThrow = new Error('boom');

    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));

    expect(res.status).toBe(502);
    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(doc?.status).toBe('awaiting_clarification');
    expect(doc?.turnCount).toBe(0);
  });

  it('returns 504 on Gemini timeout and rolls back the lease', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const conversationRepo = new InMemoryPluginConversationRepository();
    const geminiClient = new FakeGeminiClient();
    geminiClient.abortOnCall = true;
    const token = await createSession(sessionRepo);
    await createConversation(conversationRepo, token);
    const app = createTestApp({
      pluginSessionRepo: sessionRepo,
      pluginConversationRepo: conversationRepo,
      pluginRequestDedupeRepo: new InMemoryPluginRequestDedupeRepository(),
      pluginEventCandidateRepo: new InMemoryPluginEventCandidateRepository(),
      geminiClient,
      clock: fixedClock(NOW),
      geminiTimeoutMs: 50,
    });

    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(504);
    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(doc?.status).toBe('awaiting_clarification');
  });

  it('returns 502 and rolls back on malformed model output', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.followupResponseJson = 'not valid json{{{';
    const res = await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    expect(res.status).toBe(502);
    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(doc?.status).toBe('awaiting_clarification');
  });

  it('does not persist audio or the Gemini raw response anywhere', async () => {
    const { app, token, geminiClient, conversationRepo } = await setup();
    geminiClient.followupResponseJson = followupResultJson({ title: 'UNIQUE_SENTINEL', explicitCorrection: true });
    await postFollowup(app, token, buildWav({ durationSeconds: 2 }));
    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(JSON.stringify(doc)).not.toContain('UNIQUE_SENTINEL');
  });
});

describe('POST /plugin/analyze-followup-audio privacy: no sensitive logs', () => {
  it('never logs the question text, answer content, title/date, token, or installId', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, token, geminiClient } = await setup();
    geminiClient.followupResponseJson = followupResultJson({ title: 'UNIQUE_SENTINEL_TITLE', explicitCorrection: true });

    await postFollowup(app, token, buildWav({ durationSeconds: 2 }));

    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain('UNIQUE_SENTINEL_TITLE');
    expect(allLogText).not.toContain(token);
    expect(allLogText).not.toContain(INSTALL_ID);
    logSpy.mockRestore();
  });
});
