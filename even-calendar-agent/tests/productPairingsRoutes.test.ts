import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';
import { InMemoryProductPairingRepository } from '../src/product/productPairingRepository.js';
import { InMemoryProductInstallationRepository } from '../src/product/productInstallationRepository.js';
import { InMemoryProductAuditRepository } from '../src/product/productAuditRepository.js';
import { InMemoryProductDeviceRefreshTokenRepository } from '../src/product/productDeviceRefreshTokenRepository.js';
import { InMemoryProductExchangeCoordinator } from '../src/product/productExchangeCoordinator.js';
import { InMemoryPluginRateLimitRepository } from '../src/firestore/pluginRateLimitRepository.js';
import { InMemoryPluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { fixedClock } from '../src/time/clock.js';
import { hashValue } from '../src/security/devSessionToken.js';
import type { ProductPairingSessionDoc, ProductInstallationDoc, PluginSessionDoc, ProductDeviceRefreshTokenDoc } from '../src/firestore/models.js';

const NOW = new Date('2026-07-23T05:00:00Z');
const INSTALL_ID = '11111111-1111-4111-8111-111111111111';

/** client-generated credential方式のテスト用candidate。実運用のcrypto.getRandomValues(32bytes)と
 *  同じ64桁hex形式。 */
function randomCredentialCandidate(): string {
  return randomBytes(32).toString('hex');
}

function setup(opts: { rateLimitPerMinute?: number; now?: Date } = {}) {
  const pairingStore = new Map<string, ProductPairingSessionDoc>();
  const installationStore = new Map<string, ProductInstallationDoc>();
  const sessionStore = new Map<string, PluginSessionDoc>();
  const refreshStore = new Map<string, ProductDeviceRefreshTokenDoc>();

  const productPairingRepo = new InMemoryProductPairingRepository(pairingStore);
  const productInstallationRepo = new InMemoryProductInstallationRepository(installationStore);
  const productAuditRepo = new InMemoryProductAuditRepository();
  const productDeviceRefreshTokenRepo = new InMemoryProductDeviceRefreshTokenRepository(refreshStore);
  const productExchangeCoordinator = new InMemoryProductExchangeCoordinator(pairingStore, installationStore, sessionStore, refreshStore);
  const pluginRateLimitRepo = new InMemoryPluginRateLimitRepository();
  const pluginSessionRepo = new InMemoryPluginSessionRepository(sessionStore);
  const app = createTestApp({
    clock: fixedClock(opts.now ?? NOW),
    productPairingRepo,
    productInstallationRepo,
    productAuditRepo,
    productDeviceRefreshTokenRepo,
    productExchangeCoordinator,
    pluginRateLimitRepo,
    pluginSessionRepo,
    ...(opts.rateLimitPerMinute !== undefined ? { productPairingRateLimitPerMinute: opts.rateLimitPerMinute } : {}),
  });
  return { app, productPairingRepo, productInstallationRepo, productAuditRepo, productDeviceRefreshTokenRepo, productExchangeCoordinator, pluginSessionRepo };
}

describe('POST /product/pairings', () => {
  it('creates a pairing and returns pairingId/userCode/verificationUrl/expiresInSeconds/pollIntervalSeconds', async () => {
    const { app } = setup();
    const res = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID, appVersion: '1.0.0', sdkVersion: '0.0.12' });
    expect(res.status).toBe(201);
    expect(res.body.pairingId).toEqual(expect.any(String));
    expect(res.body.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.body.verificationUrl).toContain('/connect');
    expect(res.body.expiresInSeconds).toBe(600);
    expect(res.body.pollIntervalSeconds).toBe(3);
  });

  it('returns 400 for a missing/invalid installationId', async () => {
    const { app } = setup();
    const res = await request(app).post('/product/pairings').send({ installationId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('creates the installation record on first pairing (getOrCreate)', async () => {
    const { app, productInstallationRepo } = setup();
    await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    expect(await productInstallationRepo.get(INSTALL_ID)).not.toBeNull();
  });

  it('cancels a prior pending pairing for the same installation (single active pairing)', async () => {
    const { app, productPairingRepo } = setup();
    const first = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    const oldDoc = await productPairingRepo.getById(first.body.pairingId);
    expect(oldDoc?.status).toBe('cancelled');
  });

  it('never stores the raw userCode server-side (only its hash)', async () => {
    const { app, productPairingRepo } = setup();
    const res = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    const doc = await productPairingRepo.getById(res.body.pairingId);
    expect(JSON.stringify(doc)).not.toContain(res.body.userCode.replace('-', ''));
  });

  it('sets Cache-Control: no-store', async () => {
    const { app } = setup();
    const res = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('never logs the raw userCode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app } = setup();
    const res = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain(res.body.userCode);
    logSpy.mockRestore();
  });

  it('rate-limits repeated pairing creation from the same installation', async () => {
    const { app } = setup({ rateLimitPerMinute: 2 });
    await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    const third = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
  });
});

describe('GET /product/pairings/:pairingId/status', () => {
  it('returns status: pending right after creation', async () => {
    const { app } = setup();
    const created = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    const res = await request(app).get(`/product/pairings/${created.body.pairingId}/status`).set('X-Installation-Id', INSTALL_ID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'pending' });
  });

  it('returns only a status enum — no userId/token/other pairing fields', async () => {
    const { app } = setup();
    const created = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    const res = await request(app).get(`/product/pairings/${created.body.pairingId}/status`).set('X-Installation-Id', INSTALL_ID);
    expect(Object.keys(res.body)).toEqual(['status']);
  });

  it('returns status: expired for an unknown pairingId (enumeration-resistant)', async () => {
    const { app } = setup();
    const res = await request(app)
      .get('/product/pairings/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/status')
      .set('X-Installation-Id', INSTALL_ID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'expired' });
  });

  it('returns status: expired when the installation does not match (no information leak)', async () => {
    const { app } = setup();
    const created = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    const res = await request(app)
      .get(`/product/pairings/${created.body.pairingId}/status`)
      .set('X-Installation-Id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(res.body).toEqual({ status: 'expired' });
  });

  it('returns status: expired once the TTL has elapsed', async () => {
    const { app, productPairingRepo } = setup();
    const created = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    const laterApp = createTestApp({
      clock: fixedClock(new Date(NOW.getTime() + 601_000)),
      productPairingRepo,
    });
    const res = await request(laterApp).get(`/product/pairings/${created.body.pairingId}/status`).set('X-Installation-Id', INSTALL_ID);
    expect(res.body).toEqual({ status: 'expired' });
  });

  it('returns 400 for a malformed pairingId or installationId', async () => {
    const { app } = setup();
    const res = await request(app).get('/product/pairings/not-a-uuid/status').set('X-Installation-Id', 'also-not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('reflects approved/exchanged status transitions', async () => {
    const { app, productPairingRepo } = setup();
    const created = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    await productPairingRepo.markApproved(created.body.pairingId, 'user-1', NOW);
    const res = await request(app).get(`/product/pairings/${created.body.pairingId}/status`).set('X-Installation-Id', INSTALL_ID);
    expect(res.body).toEqual({ status: 'approved' });
  });
});

describe('POST /product/pairings/:pairingId/cancel', () => {
  it('cancels a pending pairing and returns { cancelled: true }', async () => {
    const { app, productPairingRepo } = setup();
    const created = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    const res = await request(app).post(`/product/pairings/${created.body.pairingId}/cancel`).send({ installationId: INSTALL_ID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true });
    expect((await productPairingRepo.getById(created.body.pairingId))?.status).toBe('cancelled');
  });

  it('is idempotent/best-effort: returns 200 even for an unknown pairingId', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/product/pairings/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cancel')
      .send({ installationId: INSTALL_ID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true });
  });

  it('does not cancel an already-exchanged pairing', async () => {
    const { app, productPairingRepo, productExchangeCoordinator } = setup();
    const created = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    await productPairingRepo.markApproved(created.body.pairingId, 'user-1', NOW);
    await productExchangeCoordinator.exchange({
      pairingId: created.body.pairingId,
      installationId: INSTALL_ID,
      installationIdHash: hashValue(INSTALL_ID),
      accessTokenHash: hashValue(randomCredentialCandidate()),
      refreshTokenHash: hashValue(randomCredentialCandidate()),
      now: NOW,
    });
    const res = await request(app).post(`/product/pairings/${created.body.pairingId}/cancel`).send({ installationId: INSTALL_ID });
    expect(res.status).toBe(200);
    expect((await productPairingRepo.getById(created.body.pairingId))?.status).toBe('exchanged');
  });

  it('returns 400 for a malformed pairingId or installationId', async () => {
    const { app } = setup();
    const res = await request(app).post('/product/pairings/not-a-uuid/cancel').send({ installationId: 'also-not-a-uuid' });
    expect(res.status).toBe(400);
  });
});

describe('POST /product/pairings/:pairingId/exchange', () => {
  async function createApprovedPairing(app: ReturnType<typeof createTestApp>, productPairingRepo: InMemoryProductPairingRepository) {
    const created = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    await productPairingRepo.markApproved(created.body.pairingId, 'user-1', NOW);
    return created.body.pairingId as string;
  }

  function candidate() {
    return { accessToken: randomCredentialCandidate(), refreshToken: randomCredentialCandidate() };
  }

  it('exchanges an approved pairing for a device session, echoing back the client-submitted candidate', async () => {
    const { app, productPairingRepo } = setup();
    const pairingId = await createApprovedPairing(app, productPairingRepo);
    const { accessToken, refreshToken } = candidate();
    const res = await request(app).post(`/product/pairings/${pairingId}/exchange`).send({ installationId: INSTALL_ID, accessToken, refreshToken });
    expect(res.status).toBe(200);
    // Backendは受け取った候補をそのまま返すだけで、自分では生成しない。
    expect(res.body.accessToken).toBe(accessToken);
    expect(res.body.refreshToken).toBe(refreshToken);
    expect(res.body.accessTokenExpiresInSeconds).toBe(15 * 60);
    expect(res.body.scopes).toEqual(['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read', 'calendar:update', 'calendar:delete']);
  });

  it('binds the installation to the approved user', async () => {
    const { app, productPairingRepo, productInstallationRepo } = setup();
    const pairingId = await createApprovedPairing(app, productPairingRepo);
    await request(app).post(`/product/pairings/${pairingId}/exchange`).send({ installationId: INSTALL_ID, ...candidate() });
    const installation = await productInstallationRepo.get(INSTALL_ID);
    expect(installation?.userId).toBe('user-1');
  });

  it('creates a device-type plugin session usable for authenticated routes', async () => {
    const { app, productPairingRepo, pluginSessionRepo } = setup();
    const pairingId = await createApprovedPairing(app, productPairingRepo);
    const { accessToken, refreshToken } = candidate();
    await request(app).post(`/product/pairings/${pairingId}/exchange`).send({ installationId: INSTALL_ID, accessToken, refreshToken });
    const session = await pluginSessionRepo.get(hashValue(accessToken));
    expect(session?.tokenType).toBe('device');
    expect(session?.userId).toBe('user-1');
  });

  it('rejects exchange for a pairing that is not yet approved', async () => {
    const { app } = setup();
    const created = await request(app).post('/product/pairings').send({ installationId: INSTALL_ID });
    const res = await request(app).post(`/product/pairings/${created.body.pairingId}/exchange`).send({ installationId: INSTALL_ID, ...candidate() });
    expect(res.status).toBe(409);
  });

  it('rejects a malformed accessToken/refreshToken (not 64 lowercase hex characters)', async () => {
    const { app, productPairingRepo } = setup();
    const pairingId = await createApprovedPairing(app, productPairingRepo);
    const res = await request(app)
      .post(`/product/pairings/${pairingId}/exchange`)
      .send({ installationId: INSTALL_ID, accessToken: 'not-hex', refreshToken: randomCredentialCandidate() });
    expect(res.status).toBe(400);
  });

  it('replaying the exact same candidate succeeds idempotently (does not fail, does not mint a new credential)', async () => {
    const { app, productPairingRepo, pluginSessionRepo } = setup();
    const pairingId = await createApprovedPairing(app, productPairingRepo);
    const { accessToken, refreshToken } = candidate();
    const first = await request(app).post(`/product/pairings/${pairingId}/exchange`).send({ installationId: INSTALL_ID, accessToken, refreshToken });
    const second = await request(app).post(`/product/pairings/${pairingId}/exchange`).send({ installationId: INSTALL_ID, accessToken, refreshToken });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.accessToken).toBe(accessToken);
    expect(second.body.refreshToken).toBe(refreshToken);
    // 同一tokenHashのdocが1件のみ存在する(作り直されていない)
    const session = await pluginSessionRepo.get(hashValue(accessToken));
    expect(session).not.toBeNull();
  });

  it('rejects a different candidate submitted for an already-exchanged pairing (hash_mismatch)', async () => {
    const { app, productPairingRepo } = setup();
    const pairingId = await createApprovedPairing(app, productPairingRepo);
    const first = await request(app).post(`/product/pairings/${pairingId}/exchange`).send({ installationId: INSTALL_ID, ...candidate() });
    const second = await request(app).post(`/product/pairings/${pairingId}/exchange`).send({ installationId: INSTALL_ID, ...candidate() });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it('rejects exchange when the installation has been revoked (does not re-issue/reactivate)', async () => {
    const { app, productPairingRepo, productInstallationRepo, pluginSessionRepo } = setup();
    const pairingId = await createApprovedPairing(app, productPairingRepo);
    await productInstallationRepo.revoke(INSTALL_ID, NOW);
    const { accessToken, refreshToken } = candidate();
    const res = await request(app).post(`/product/pairings/${pairingId}/exchange`).send({ installationId: INSTALL_ID, accessToken, refreshToken });
    expect(res.status).toBe(409);
    expect(await pluginSessionRepo.get(hashValue(accessToken))).toBeNull();
  });

  it('rejects exchange when the installationId does not match the pairing', async () => {
    const { app, productPairingRepo } = setup();
    const pairingId = await createApprovedPairing(app, productPairingRepo);
    const res = await request(app)
      .post(`/product/pairings/${pairingId}/exchange`)
      .send({ installationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ...candidate() });
    expect(res.status).toBe(400);
  });

  it('never logs the client-submitted or returned access/refresh token candidate', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, productPairingRepo } = setup();
    const pairingId = await createApprovedPairing(app, productPairingRepo);
    const { accessToken, refreshToken } = candidate();
    await request(app).post(`/product/pairings/${pairingId}/exchange`).send({ installationId: INSTALL_ID, accessToken, refreshToken });
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain(accessToken);
    expect(allLogText).not.toContain(refreshToken);
    logSpy.mockRestore();
  });

  it('never includes the raw access/refresh token candidate in an audit record', async () => {
    const { app, productPairingRepo, productAuditRepo } = setup();
    const pairingId = await createApprovedPairing(app, productPairingRepo);
    const { accessToken, refreshToken } = candidate();
    await request(app).post(`/product/pairings/${pairingId}/exchange`).send({ installationId: INSTALL_ID, accessToken, refreshToken });
    const serialized = JSON.stringify(productAuditRepo.entries);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain(refreshToken);
  });
});
