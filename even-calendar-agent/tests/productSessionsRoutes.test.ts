import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';
import { InMemoryProductInstallationRepository } from '../src/product/productInstallationRepository.js';
import { InMemoryProductDeviceRefreshTokenRepository } from '../src/product/productDeviceRefreshTokenRepository.js';
import { InMemoryProductAuditRepository } from '../src/product/productAuditRepository.js';
import { InMemoryPluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { InMemoryPluginRateLimitRepository } from '../src/firestore/pluginRateLimitRepository.js';
import { hashValue, generateDevSessionToken, hashDevSessionToken } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';

const NOW = new Date('2026-07-23T05:00:00Z');
const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-1';
const FAMILY_ID = 'family-1';

function thirtyDaysLater(from: Date = NOW): Date {
  return new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
}

async function setup(opts: { now?: Date; rateLimitPerMinute?: number } = {}) {
  const now = opts.now ?? NOW;
  const productInstallationRepo = new InMemoryProductInstallationRepository();
  const productDeviceRefreshTokenRepo = new InMemoryProductDeviceRefreshTokenRepository();
  const productAuditRepo = new InMemoryProductAuditRepository();
  const pluginSessionRepo = new InMemoryPluginSessionRepository();
  const pluginRateLimitRepo = new InMemoryPluginRateLimitRepository();

  await productInstallationRepo.getOrCreate({ installationId: INSTALL_ID, now, appVersion: null, sdkVersion: null });
  await productInstallationRepo.bindUser(INSTALL_ID, USER_ID, now);

  const refreshToken = generateDevSessionToken();
  const refreshTokenHash = hashValue(refreshToken);
  await productDeviceRefreshTokenRepo.create({
    refreshTokenHash,
    installationId: INSTALL_ID,
    userId: USER_ID,
    familyId: FAMILY_ID,
    generation: 1,
    now,
    expiresAt: thirtyDaysLater(now),
  });

  const accessToken = generateDevSessionToken();
  await pluginSessionRepo.create({
    tokenHash: hashDevSessionToken(accessToken),
    installId: INSTALL_ID,
    scope: ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read'],
    now,
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    tokenType: 'device',
    userId: USER_ID,
    tokenVersion: 1,
  });

  const app = createTestApp({
    clock: fixedClock(now),
    productInstallationRepo,
    productDeviceRefreshTokenRepo,
    productAuditRepo,
    pluginSessionRepo,
    pluginRateLimitRepo,
    ...(opts.rateLimitPerMinute !== undefined ? { productSessionsRateLimitPerMinute: opts.rateLimitPerMinute } : {}),
  });

  return { app, productInstallationRepo, productDeviceRefreshTokenRepo, productAuditRepo, pluginSessionRepo, refreshToken, accessToken };
}

describe('POST /product/sessions/refresh', () => {
  it('rotates the refresh token and issues a new device access token', async () => {
    const { app, refreshToken } = await setup();
    const res = await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).not.toBe(refreshToken);
    expect(res.body.scopes).toEqual(['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read', 'calendar:update', 'calendar:delete']);
  });

  it('invalidates the old refresh token after rotation (cannot be reused for a normal refresh)', async () => {
    const { app, refreshToken } = await setup();
    const first = await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken });
    expect(first.status).toBe(200);
    const second = await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken });
    expect(second.status).toBe(401);
  });

  it('detects reuse of an already-rotated refresh token and revokes the installation', async () => {
    const { app, refreshToken, productInstallationRepo } = await setup();
    await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken });
    await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken }); // reuse
    const installation = await productInstallationRepo.get(INSTALL_ID);
    expect(installation?.status).toBe('revoked');
  });

  it('rejects when the installationId does not match the token', async () => {
    const { app, refreshToken } = await setup();
    const res = await request(app)
      .post('/product/sessions/refresh')
      .set('X-Installation-Id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      .send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown refresh token generically', async () => {
    const { app } = await setup();
    const res = await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });

  it('rejects a revoked installation even with a technically-valid refresh token', async () => {
    const { app, refreshToken, productInstallationRepo } = await setup();
    await productInstallationRepo.revoke(INSTALL_ID, NOW);
    const res = await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('rate-limits repeated refresh attempts for the same installation', async () => {
    const { app, refreshToken } = await setup({ rateLimitPerMinute: 1 });
    await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken });
    const res = await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken: 'irrelevant' });
    expect(res.status).toBe(429);
  });

  it('never logs the raw refresh or access token', async () => {
    const { app, refreshToken } = await setup();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken });
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain(refreshToken);
    expect(allLogText).not.toContain(res.body.accessToken);
    logSpy.mockRestore();
  });
});

describe('GET /product/session', () => {
  it('returns connected: true for a valid device session bound to a user', async () => {
    const { app, accessToken } = await setup();
    const res = await request(app).get('/product/session').set('Authorization', `Bearer ${accessToken}`).set('X-Install-Id', INSTALL_ID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tokenType: 'device', installationId: INSTALL_ID, connected: true });
  });

  it('returns 401 for a missing/invalid token', async () => {
    const { app } = await setup();
    const res = await request(app).get('/product/session').set('X-Install-Id', INSTALL_ID);
    expect(res.status).toBe(401);
  });
});

describe('POST /product/installations/revoke', () => {
  it('revokes the installation and its refresh-token family', async () => {
    const { app, accessToken, productInstallationRepo, productDeviceRefreshTokenRepo, refreshToken } = await setup();
    const res = await request(app)
      .post('/product/installations/revoke')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Install-Id', INSTALL_ID)
      .send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true });
    expect((await productInstallationRepo.get(INSTALL_ID))?.status).toBe('revoked');
    expect((await productDeviceRefreshTokenRepo.getByHash(hashValue(refreshToken)))?.revokedAt).not.toBeNull();
  });

  it('a revoked installation can no longer refresh its session', async () => {
    const { app, accessToken, refreshToken } = await setup();
    await request(app)
      .post('/product/installations/revoke')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Install-Id', INSTALL_ID)
      .send({ refreshToken });
    const res = await request(app).post('/product/sessions/refresh').set('X-Installation-Id', INSTALL_ID).send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('returns 401 without a valid device session', async () => {
    const { app } = await setup();
    const res = await request(app).post('/product/installations/revoke').set('X-Install-Id', INSTALL_ID).send({});
    expect(res.status).toBe(401);
  });
});
