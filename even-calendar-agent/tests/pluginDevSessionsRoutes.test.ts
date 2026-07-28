import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, TEST_SETUP_ADMIN_TOKEN } from './testHelpers.js';
import { InMemoryPluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { hashDevSessionToken } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';

const VALID_INSTALL_ID = '11111111-1111-4111-8111-111111111111';

describe('POST /plugin/dev-sessions', () => {
  it('issues a session token for a valid request', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze'], expiresInSeconds: 3600 });

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThanOrEqual(32);
    expect(res.body.scope).toEqual(['audio:analyze']);
    expect(res.body.installId).toBe(VALID_INSTALL_ID);
  });

  it('defaults expiresInSeconds to 86400 when omitted', async () => {
    const app = createTestApp();
    const before = Date.now();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze'] });

    expect(res.status).toBe(201);
    const expiresAtMs = new Date(res.body.expiresAt).getTime();
    expect(expiresAtMs - before).toBeGreaterThan(86_000 * 1000);
    expect(expiresAtMs - before).toBeLessThanOrEqual(86_400 * 1000 + 5000);
  });

  it('rejects expiresInSeconds greater than 24 hours', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze'], expiresInSeconds: 86_401 });
    expect(res.status).toBe(400);
  });

  it('rejects a scope value outside the defined set (audio:analyze, calendar:create, calendar:status)', async () => {
    const app = createTestApp();
    const res1 = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze', 'calendar:write'] });
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['calendar:write'] });
    expect(res2.status).toBe(400);
  });

  it('rejects an empty scope array', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: [] });
    expect(res.status).toBe(400);
  });

  it('rejects a scope array with duplicate entries', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze', 'audio:analyze'] });
    expect(res.status).toBe(400);
  });

  it('accepts the full scope set: audio:analyze, calendar:create, calendar:status', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze', 'calendar:create', 'calendar:status'] });
    expect(res.status).toBe(201);
    expect(res.body.scope).toEqual(['audio:analyze', 'calendar:create', 'calendar:status']);
  });

  it('accepts a partial subset of scopes, e.g. only calendar:create', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['calendar:create'] });
    expect(res.status).toBe(201);
    expect(res.body.scope).toEqual(['calendar:create']);
  });

  it('still enforces the max 24h expiry regardless of scope', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({
        installId: VALID_INSTALL_ID,
        scope: ['audio:analyze', 'calendar:create', 'calendar:status'],
        expiresInSeconds: 86_401,
      });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed installId', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: 'not-a-uuid', scope: ['audio:analyze'] });
    expect(res.status).toBe(400);
  });

  it('rejects requests without a valid setup admin token', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze'] });
    expect(res.status).toBe(401);
  });

  it('rejects requests with the wrong bearer token', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', 'Bearer wrong-token')
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze'] });
    expect(res.status).toBe(401);
  });

  it('never stores the plaintext token in the repository (only its SHA-256 hash)', async () => {
    const repo = new InMemoryPluginSessionRepository();
    const app = createTestApp({ pluginSessionRepo: repo });
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze'] });

    expect(res.status).toBe(201);
    const expectedHash = hashDevSessionToken(res.body.token as string);
    const stored = await repo.get(expectedHash);
    expect(stored).not.toBeNull();
    // ドキュメント内のどのフィールドにも平文トークンが含まれていないことを確認する
    expect(JSON.stringify(stored)).not.toContain(res.body.token);
  });

  it('does not log the admin token or the issued plaintext token', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze'] });

    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain(TEST_SETUP_ADMIN_TOKEN);
    expect(allLogText).not.toContain(res.body.token);
    logSpy.mockRestore();
  });
});

describe('POST /plugin/dev-sessions/revoke', () => {
  async function issueSession(app: ReturnType<typeof createTestApp>): Promise<{ token: string; tokenHash: string }> {
    const res = await request(app)
      .post('/plugin/dev-sessions')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ installId: VALID_INSTALL_ID, scope: ['audio:analyze'] });
    return { token: res.body.token as string, tokenHash: res.body.tokenHash as string };
  }

  it('revokes an existing session', async () => {
    const repo = new InMemoryPluginSessionRepository();
    const app = createTestApp({ pluginSessionRepo: repo });
    const { tokenHash } = await issueSession(app);

    const res = await request(app)
      .post('/plugin/dev-sessions/revoke')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ tokenHash });

    expect(res.status).toBe(200);
    const stored = await repo.get(tokenHash);
    expect(stored?.revokedAt).not.toBeNull();
  });

  it('returns 404 for an unknown tokenHash', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions/revoke')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ tokenHash: 'a'.repeat(64) });
    expect(res.status).toBe(404);
  });

  it('rejects a malformed tokenHash', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions/revoke')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ tokenHash: 'not-a-hash' });
    expect(res.status).toBe(400);
  });

  it('rejects requests without a valid setup admin token', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/plugin/dev-sessions/revoke')
      .send({ tokenHash: 'a'.repeat(64) });
    expect(res.status).toBe(401);
  });

  it('a revoked session can no longer be looked up as active (revokedAt set, expiresAt unchanged)', async () => {
    const repo = new InMemoryPluginSessionRepository();
    const now = new Date('2026-07-22T00:00:00Z');
    const app = createTestApp({ pluginSessionRepo: repo, clock: fixedClock(now) });
    const { tokenHash } = await issueSession(app);

    await request(app)
      .post('/plugin/dev-sessions/revoke')
      .set('Authorization', `Bearer ${TEST_SETUP_ADMIN_TOKEN}`)
      .send({ tokenHash });

    const stored = await repo.get(tokenHash);
    expect(stored?.revokedAt?.getTime()).toBe(now.getTime());
  });
});
