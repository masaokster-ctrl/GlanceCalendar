import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';
import { InMemoryPluginSessionRepository, type PluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { InMemoryPluginConversationRepository, type PluginConversationRepository } from '../src/firestore/pluginConversationRepository.js';
import { generateDevSessionToken, hashDevSessionToken, hashValue } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';

const INSTALL_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-07-22T05:00:00Z');

async function createSession(repo: PluginSessionRepository): Promise<string> {
  const token = generateDevSessionToken();
  await repo.create({
    tokenHash: hashDevSessionToken(token),
    installId: INSTALL_ID,
    scope: ['audio:analyze', 'calendar:create', 'calendar:status'],
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
  });
  return token;
}

async function setup(): Promise<{
  app: ReturnType<typeof createTestApp>;
  conversationRepo: PluginConversationRepository;
  token: string;
}> {
  const sessionRepo = new InMemoryPluginSessionRepository();
  const conversationRepo = new InMemoryPluginConversationRepository();
  const token = await createSession(sessionRepo);
  await conversationRepo.create({
    conversationId: CONVERSATION_ID,
    sessionHash: hashDevSessionToken(token),
    installIdHash: hashValue(INSTALL_ID),
    partialCandidate: { title: null, startLocal: null, endLocal: null, timeZone: 'Asia/Tokyo', allDay: false },
    missingField: 'start_time',
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 600_000),
  });
  const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginConversationRepo: conversationRepo, clock: fixedClock(NOW) });
  return { app, conversationRepo, token };
}

describe('OPTIONS /plugin/conversations/cancel', () => {
  it('responds 204 with scoped CORS headers', async () => {
    const { app } = await setup();
    const res = await request(app).options('/plugin/conversations/cancel');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('POST /plugin/conversations/cancel', () => {
  it('cancels an active conversation', async () => {
    const { app, token, conversationRepo } = await setup();
    const res = await request(app)
      .post('/plugin/conversations/cancel')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .send({ conversationId: CONVERSATION_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ conversationId: CONVERSATION_ID, status: 'cancelled' });
    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(doc?.status).toBe('cancelled');
  });

  it('is idempotent: calling it twice does not error', async () => {
    const { app, token } = await setup();
    const first = await request(app)
      .post('/plugin/conversations/cancel')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .send({ conversationId: CONVERSATION_ID });
    const second = await request(app)
      .post('/plugin/conversations/cancel')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .send({ conversationId: CONVERSATION_ID });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('does not create a candidate as a side effect', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .post('/plugin/conversations/cancel')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .send({ conversationId: CONVERSATION_ID });
    expect(res.body).not.toHaveProperty('candidateId');
  });

  it('returns 401 without a valid session token', async () => {
    const { app } = await setup();
    const res = await request(app).post('/plugin/conversations/cancel').set('X-Install-Id', INSTALL_ID).send({ conversationId: CONVERSATION_ID });
    expect(res.status).toBe(401);
  });

  it('returns 400 for a malformed conversationId', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .post('/plugin/conversations/cancel')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .send({ conversationId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('returns 200 without leaking info for an unknown conversationId (idempotent no-op)', async () => {
    const { app, token } = await setup();
    const res = await request(app)
      .post('/plugin/conversations/cancel')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .send({ conversationId: '99999999-9999-4999-8999-999999999999' });
    expect(res.status).toBe(200);
  });

  it('returns 200 without cancelling a conversation belonging to a different session', async () => {
    const sessionRepo = new InMemoryPluginSessionRepository();
    const conversationRepo = new InMemoryPluginConversationRepository();
    const token = await createSession(sessionRepo);
    await conversationRepo.create({
      conversationId: CONVERSATION_ID,
      sessionHash: 'someone-elses-hash',
      installIdHash: hashValue(INSTALL_ID),
      partialCandidate: { title: null, startLocal: null, endLocal: null, timeZone: 'Asia/Tokyo', allDay: false },
      missingField: 'start_time',
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 600_000),
    });
    const app = createTestApp({ pluginSessionRepo: sessionRepo, pluginConversationRepo: conversationRepo, clock: fixedClock(NOW) });

    const res = await request(app)
      .post('/plugin/conversations/cancel')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .send({ conversationId: CONVERSATION_ID });

    expect(res.status).toBe(200);
    const doc = await conversationRepo.get(CONVERSATION_ID);
    expect(doc?.status).toBe('awaiting_clarification'); // 他セッションの会話は変更されない
  });

  it('never logs the admin/session token or installId raw value', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, token } = await setup();
    await request(app)
      .post('/plugin/conversations/cancel')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Install-Id', INSTALL_ID)
      .send({ conversationId: CONVERSATION_ID });

    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain(token);
    expect(allLogText).not.toContain(INSTALL_ID);
    logSpy.mockRestore();
  });
});
