import { describe, expect, it } from 'vitest';
import { InMemoryProductPairingRepository } from '../src/product/productPairingRepository.js';

const NOW = new Date('2026-07-23T05:00:00Z');
const PAIRING_ID = 'pairing-1';
const INSTALL_HASH = 'install-hash-1';
const CODE_HASH = 'code-hash-1';

function tenMinutesLater(from: Date = NOW): Date {
  return new Date(from.getTime() + 10 * 60 * 1000);
}

describe('ProductPairingRepository — create/lookup', () => {
  it('creates a pairing in pending status', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: PAIRING_ID, userCodeHash: CODE_HASH, installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    const doc = await repo.getById(PAIRING_ID);
    expect(doc?.status).toBe('pending');
    expect(doc?.userId).toBeNull();
    expect(doc?.attemptCount).toBe(0);
  });

  it('findPendingByUserCodeHash finds a not-yet-expired pending pairing', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: PAIRING_ID, userCodeHash: CODE_HASH, installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    const found = await repo.findPendingByUserCodeHash(CODE_HASH, NOW);
    expect(found?.pairingId).toBe(PAIRING_ID);
  });

  it('findPendingByUserCodeHash returns null once the TTL has elapsed', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: PAIRING_ID, userCodeHash: CODE_HASH, installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    const afterExpiry = new Date(tenMinutesLater().getTime() + 1);
    const found = await repo.findPendingByUserCodeHash(CODE_HASH, afterExpiry);
    expect(found).toBeNull();
  });

  it('findPendingByUserCodeHash does not match a wrong code hash', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: PAIRING_ID, userCodeHash: CODE_HASH, installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    expect(await repo.findPendingByUserCodeHash('wrong-hash', NOW)).toBeNull();
  });
});

describe('ProductPairingRepository — single active pairing per installation', () => {
  it('cancelActiveForInstallation cancels an existing pending/oauth_in_progress pairing for the same installation', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: 'old', userCodeHash: 'old-code', installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    await repo.cancelActiveForInstallation(INSTALL_HASH, NOW);
    const old = await repo.getById('old');
    expect(old?.status).toBe('cancelled');
  });

  it('cancelActiveForInstallation does not affect pairings for other installations', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: 'other', userCodeHash: 'other-code', installationIdHash: 'other-install-hash', now: NOW, expiresAt: tenMinutesLater() });
    await repo.cancelActiveForInstallation(INSTALL_HASH, NOW);
    const other = await repo.getById('other');
    expect(other?.status).toBe('pending');
  });

  it('findActiveByInstallationHash returns the active (pending/oauth_in_progress) pairing, not a cancelled one', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: PAIRING_ID, userCodeHash: CODE_HASH, installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    expect(await repo.findActiveByInstallationHash(INSTALL_HASH, NOW)).not.toBeNull();
    await repo.cancelActiveForInstallation(INSTALL_HASH, NOW);
    expect(await repo.findActiveByInstallationHash(INSTALL_HASH, NOW)).toBeNull();
  });
});

describe('ProductPairingRepository — status transitions', () => {
  it('markOAuthInProgress transitions pending -> oauth_in_progress', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: PAIRING_ID, userCodeHash: CODE_HASH, installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    await repo.markOAuthInProgress(PAIRING_ID);
    expect((await repo.getById(PAIRING_ID))?.status).toBe('oauth_in_progress');
  });

  it('markApproved sets status=approved, userId, and approvedAt', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: PAIRING_ID, userCodeHash: CODE_HASH, installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    await repo.markApproved(PAIRING_ID, 'user-1', NOW);
    const doc = await repo.getById(PAIRING_ID);
    expect(doc?.status).toBe('approved');
    expect(doc?.userId).toBe('user-1');
    expect(doc?.approvedAt).toEqual(NOW);
  });

  it('markFailed sets status=failed with the sanitized error code', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: PAIRING_ID, userCodeHash: CODE_HASH, installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    await repo.markFailed(PAIRING_ID, 'oauth_exchange_failed', NOW);
    const doc = await repo.getById(PAIRING_ID);
    expect(doc?.status).toBe('failed');
    expect(doc?.sanitizedErrorCode).toBe('oauth_exchange_failed');
  });

  it('markCancelled sets status=cancelled', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: PAIRING_ID, userCodeHash: CODE_HASH, installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    await repo.markCancelled(PAIRING_ID, NOW);
    expect((await repo.getById(PAIRING_ID))?.status).toBe('cancelled');
  });

  it('recordPollAttempt increments attemptCount and sets lastPollAt', async () => {
    const repo = new InMemoryProductPairingRepository();
    await repo.create({ pairingId: PAIRING_ID, userCodeHash: CODE_HASH, installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    await repo.recordPollAttempt(PAIRING_ID, NOW);
    await repo.recordPollAttempt(PAIRING_ID, NOW);
    const doc = await repo.getById(PAIRING_ID);
    expect(doc?.attemptCount).toBe(2);
    expect(doc?.lastPollAt).toEqual(NOW);
  });
});

// exchange(approved→exchanged遷移・credential発行)のテストは productExchangeCoordinator.test.ts へ移動した
// (ProductPairingRepository単独のtransactionではpluginSessions/productDeviceRefreshTokens/
// productInstallationsとのatomic性を保証できないため、専任のcoordinatorに責務を移したことに伴う)。
