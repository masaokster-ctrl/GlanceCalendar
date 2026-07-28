import { describe, expect, it } from 'vitest';
import { InMemoryProductInstallationRepository } from '../src/product/productInstallationRepository.js';

const NOW = new Date('2026-07-23T05:00:00Z');
const INSTALL_ID = '11111111-1111-4111-8111-111111111111';

describe('ProductInstallationRepository', () => {
  it('getOrCreate creates a new installation with tokenVersion=1 and status=active', async () => {
    const repo = new InMemoryProductInstallationRepository();
    const doc = await repo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: '1.0.0', sdkVersion: '0.0.12' });
    expect(doc.status).toBe('active');
    expect(doc.tokenVersion).toBe(1);
    expect(doc.userId).toBeNull();
    expect(doc.appVersion).toBe('1.0.0');
  });

  it('getOrCreate is idempotent: a second call returns the existing doc unchanged', async () => {
    const repo = new InMemoryProductInstallationRepository();
    const first = await repo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: '1.0.0', sdkVersion: '0.0.12' });
    const second = await repo.getOrCreate({ installationId: INSTALL_ID, now: new Date(NOW.getTime() + 1000), appVersion: '2.0.0', sdkVersion: '0.0.13' });
    expect(second).toEqual(first);
  });

  it('bindUser sets userId and pairedAt', async () => {
    const repo = new InMemoryProductInstallationRepository();
    await repo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: null, sdkVersion: null });
    await repo.bindUser(INSTALL_ID, 'user-1', NOW);
    const doc = await repo.get(INSTALL_ID);
    expect(doc?.userId).toBe('user-1');
    expect(doc?.pairedAt).toEqual(NOW);
  });

  it('touchLastSeen updates lastSeenAt without touching other fields', async () => {
    const repo = new InMemoryProductInstallationRepository();
    await repo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: null, sdkVersion: null });
    const later = new Date(NOW.getTime() + 60_000);
    await repo.touchLastSeen(INSTALL_ID, later);
    const doc = await repo.get(INSTALL_ID);
    expect(doc?.lastSeenAt).toEqual(later);
    expect(doc?.status).toBe('active');
  });

  it('revoke sets status=revoked, revokedAt, and increments tokenVersion (bulk session invalidation)', async () => {
    const repo = new InMemoryProductInstallationRepository();
    await repo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: null, sdkVersion: null });
    await repo.revoke(INSTALL_ID, NOW);
    const doc = await repo.get(INSTALL_ID);
    expect(doc?.status).toBe('revoked');
    expect(doc?.revokedAt).toEqual(NOW);
    expect(doc?.tokenVersion).toBe(2);
  });

  it('get returns null for an unknown installationId', async () => {
    const repo = new InMemoryProductInstallationRepository();
    expect(await repo.get('unknown')).toBeNull();
  });
});
