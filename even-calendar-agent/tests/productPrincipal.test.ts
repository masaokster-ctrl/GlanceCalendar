import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { resolvePrincipal } from '../src/product/principal.js';
import { InMemoryPluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { InMemoryProductInstallationRepository } from '../src/product/productInstallationRepository.js';
import { generateDevSessionToken, hashDevSessionToken } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';

const NOW = new Date('2026-07-23T05:00:00Z');
const INSTALL_ID = '11111111-1111-4111-8111-111111111111';

function fakeReq(headers: Record<string, string | undefined>): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
  } as unknown as Request;
}

describe('resolvePrincipal — dev tokens', () => {
  it('resolves a dev session (no tokenType set) as tokenType: dev', async () => {
    const pluginSessionRepo = new InMemoryPluginSessionRepository();
    const token = generateDevSessionToken();
    await pluginSessionRepo.create({
      tokenHash: hashDevSessionToken(token),
      installId: INSTALL_ID,
      scope: ['calendar:read'],
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });

    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo },
      'calendar:read',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.tokenType).toBe('dev');
      expect(result.principal.installId).toBe(INSTALL_ID);
      expect(result.principal.userId).toBeNull();
    }
  });

  it('returns 401 for a missing Authorization header', async () => {
    const pluginSessionRepo = new InMemoryPluginSessionRepository();
    const result = await resolvePrincipal(
      fakeReq({ 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo },
      'calendar:read',
    );
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it('returns 400 for a missing X-Install-Id header', async () => {
    const pluginSessionRepo = new InMemoryPluginSessionRepository();
    const token = generateDevSessionToken();
    await pluginSessionRepo.create({
      tokenHash: hashDevSessionToken(token),
      installId: INSTALL_ID,
      scope: ['calendar:read'],
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    const result = await resolvePrincipal(fakeReq({ authorization: `Bearer ${token}` }), { clock: fixedClock(NOW), pluginSessionRepo }, 'calendar:read');
    expect(result).toEqual({ ok: false, status: 400 });
  });

  it('returns 401 for an expired session', async () => {
    const pluginSessionRepo = new InMemoryPluginSessionRepository();
    const token = generateDevSessionToken();
    await pluginSessionRepo.create({
      tokenHash: hashDevSessionToken(token),
      installId: INSTALL_ID,
      scope: ['calendar:read'],
      now: NOW,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo },
      'calendar:read',
    );
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it('returns 401 for a revoked session', async () => {
    const pluginSessionRepo = new InMemoryPluginSessionRepository();
    const token = generateDevSessionToken();
    const tokenHash = hashDevSessionToken(token);
    await pluginSessionRepo.create({
      tokenHash,
      installId: INSTALL_ID,
      scope: ['calendar:read'],
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    await pluginSessionRepo.revoke(tokenHash, NOW);
    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo },
      'calendar:read',
    );
    expect(result).toEqual({ ok: false, status: 401 });
  });

  it('returns 403 when the required scope is missing', async () => {
    const pluginSessionRepo = new InMemoryPluginSessionRepository();
    const token = generateDevSessionToken();
    await pluginSessionRepo.create({
      tokenHash: hashDevSessionToken(token),
      installId: INSTALL_ID,
      scope: ['audio:analyze'],
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo },
      'calendar:read',
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it('returns 403 when X-Install-Id does not match the session', async () => {
    const pluginSessionRepo = new InMemoryPluginSessionRepository();
    const token = generateDevSessionToken();
    await pluginSessionRepo.create({
      tokenHash: hashDevSessionToken(token),
      installId: INSTALL_ID,
      scope: ['calendar:read'],
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      { clock: fixedClock(NOW), pluginSessionRepo },
      'calendar:read',
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });
});

describe('resolvePrincipal — device tokens (Phase 2H)', () => {
  async function setupDeviceSession(opts: {
    tokenVersion?: number;
    installationStatus?: 'active' | 'revoked';
    bindInstallationToUser?: boolean;
    sessionUserId?: string | null;
  } = {}) {
    const pluginSessionRepo = new InMemoryPluginSessionRepository();
    const productInstallationRepo = new InMemoryProductInstallationRepository();
    const sessionUserId = opts.sessionUserId === undefined ? 'user-1' : opts.sessionUserId;
    const bindInstallationToUser = opts.bindInstallationToUser ?? true;

    await productInstallationRepo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: null, sdkVersion: null });
    if (bindInstallationToUser) {
      await productInstallationRepo.bindUser(INSTALL_ID, 'user-1', NOW);
    }
    if (opts.installationStatus === 'revoked') {
      await productInstallationRepo.revoke(INSTALL_ID, NOW);
    }

    const installation = await productInstallationRepo.get(INSTALL_ID);
    const tokenVersion = opts.tokenVersion !== undefined ? opts.tokenVersion : installation?.tokenVersion;

    const token = generateDevSessionToken();
    await pluginSessionRepo.create({
      tokenHash: hashDevSessionToken(token),
      installId: INSTALL_ID,
      scope: ['calendar:read'],
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      tokenType: 'device',
      userId: sessionUserId,
      ...(tokenVersion !== undefined ? { tokenVersion } : {}),
    });

    return { pluginSessionRepo, productInstallationRepo, token };
  }

  it('resolves a valid device session as tokenType: device with userId set', async () => {
    const { pluginSessionRepo, productInstallationRepo, token } = await setupDeviceSession();
    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo, productInstallationRepo },
      'calendar:read',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.tokenType).toBe('device');
      expect(result.principal.userId).toBe('user-1');
    }
  });

  it('returns 403 for a device session when productInstallationRepo is not provided (dev-only route)', async () => {
    const { pluginSessionRepo, token } = await setupDeviceSession();
    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo },
      'calendar:read',
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it('returns 403 when the installation has been revoked (bulk session revocation)', async () => {
    const { pluginSessionRepo, productInstallationRepo, token } = await setupDeviceSession({ installationStatus: 'revoked' });
    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo, productInstallationRepo },
      'calendar:read',
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it('returns 403 when the session tokenVersion no longer matches the installation (revoke-then-reuse)', async () => {
    const { pluginSessionRepo, productInstallationRepo, token } = await setupDeviceSession({ tokenVersion: 1 });
    // installationのtokenVersionを2へ進める(=以前発行したdevice sessionを一括失効させる想定)
    await productInstallationRepo.revoke(INSTALL_ID, NOW);
    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo, productInstallationRepo },
      'calendar:read',
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it('returns 403 when the installation is not bound to any user', async () => {
    const pluginSessionRepo = new InMemoryPluginSessionRepository();
    const productInstallationRepo = new InMemoryProductInstallationRepository();
    await productInstallationRepo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: null, sdkVersion: null });
    const token = generateDevSessionToken();
    await pluginSessionRepo.create({
      tokenHash: hashDevSessionToken(token),
      installId: INSTALL_ID,
      scope: ['calendar:read'],
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      tokenType: 'device',
      userId: 'user-1',
      tokenVersion: 1,
    });
    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo, productInstallationRepo },
      'calendar:read',
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  it('returns 403 when the session userId does not match the installation-bound userId', async () => {
    const { pluginSessionRepo, productInstallationRepo, token } = await setupDeviceSession({ sessionUserId: 'someone-else' });
    const result = await resolvePrincipal(
      fakeReq({ authorization: `Bearer ${token}`, 'x-install-id': INSTALL_ID }),
      { clock: fixedClock(NOW), pluginSessionRepo, productInstallationRepo },
      'calendar:read',
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });
});
