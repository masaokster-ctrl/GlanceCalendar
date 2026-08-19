import { describe, expect, it } from 'vitest';
import { InMemoryProductExchangeCoordinator } from '../src/product/productExchangeCoordinator.js';
import { InMemoryProductPairingRepository } from '../src/product/productPairingRepository.js';
import { InMemoryProductInstallationRepository } from '../src/product/productInstallationRepository.js';
import { InMemoryPluginSessionRepository } from '../src/firestore/pluginSessionRepository.js';
import { InMemoryProductDeviceRefreshTokenRepository } from '../src/product/productDeviceRefreshTokenRepository.js';
import type { ProductPairingSessionDoc } from '../src/firestore/models.js';
import type { ProductInstallationDoc } from '../src/firestore/models.js';
import type { PluginSessionDoc } from '../src/firestore/models.js';
import type { ProductDeviceRefreshTokenDoc } from '../src/firestore/models.js';

const NOW = new Date('2026-07-23T05:00:00Z');
const PAIRING_ID = 'pairing-1';
const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
const INSTALL_HASH = 'install-hash-1';
const ACCESS_HASH = 'a'.repeat(64);
const REFRESH_HASH = 'b'.repeat(64);
const OTHER_ACCESS_HASH = 'c'.repeat(64);
const OTHER_REFRESH_HASH = 'd'.repeat(64);

function tenMinutesLater(from: Date = NOW): Date {
  return new Date(from.getTime() + 10 * 60 * 1000);
}

/** pairingRepo/installationRepo/pluginSessionRepo/deviceRefreshTokenRepoとcoordinatorが同じstoreを
 *  共有する構成を組み立てる(createApp()のデフォルト配線と同じ考え方)。 */
function harness() {
  const pairingStore = new Map<string, ProductPairingSessionDoc>();
  const installationStore = new Map<string, ProductInstallationDoc>();
  const sessionStore = new Map<string, PluginSessionDoc>();
  const refreshStore = new Map<string, ProductDeviceRefreshTokenDoc>();

  const pairingRepo = new InMemoryProductPairingRepository(pairingStore);
  const installationRepo = new InMemoryProductInstallationRepository(installationStore);
  const sessionRepo = new InMemoryPluginSessionRepository(sessionStore);
  const refreshRepo = new InMemoryProductDeviceRefreshTokenRepository(refreshStore);
  const coordinator = new InMemoryProductExchangeCoordinator(pairingStore, installationStore, sessionStore, refreshStore);

  return { pairingRepo, installationRepo, sessionRepo, refreshRepo, coordinator };
}

async function approvedPairing(h: ReturnType<typeof harness>, userId = 'user-1'): Promise<void> {
  await h.installationRepo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: null, sdkVersion: null });
  await h.pairingRepo.create({ pairingId: PAIRING_ID, userCodeHash: 'code-hash', installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
  await h.pairingRepo.markApproved(PAIRING_ID, userId, NOW);
}

describe('ProductExchangeCoordinator — initial registration', () => {
  it('registers the submitted hash pair atomically and creates matching session/refresh docs', async () => {
    const h = harness();
    await approvedPairing(h);
    const result = await h.coordinator.exchange({
      pairingId: PAIRING_ID, installationId: INSTALL_ID, installationIdHash: INSTALL_HASH,
      accessTokenHash: ACCESS_HASH, refreshTokenHash: REFRESH_HASH, now: NOW,
    });
    expect(result.kind).toBe('registered');
    if (result.kind !== 'registered') return;
    expect(result.accessTokenExpiresInSeconds).toBe(15 * 60);
    expect(result.userId).toBe('user-1');

    const pairing = await h.pairingRepo.getById(PAIRING_ID);
    expect(pairing?.status).toBe('exchanged');
    expect(pairing?.exchangeAccessTokenHash).toBe(ACCESS_HASH);
    expect(pairing?.exchangeRefreshTokenHash).toBe(REFRESH_HASH);

    expect(await h.sessionRepo.get(ACCESS_HASH)).not.toBeNull();
    expect(await h.refreshRepo.getByHash(REFRESH_HASH)).not.toBeNull();

    const installation = await h.installationRepo.get(INSTALL_ID);
    expect(installation?.userId).toBe('user-1');
  });

  it('returns not_approved when the pairing is still pending', async () => {
    const h = harness();
    await h.installationRepo.getOrCreate({ installationId: INSTALL_ID, now: NOW, appVersion: null, sdkVersion: null });
    await h.pairingRepo.create({ pairingId: PAIRING_ID, userCodeHash: 'code-hash', installationIdHash: INSTALL_HASH, now: NOW, expiresAt: tenMinutesLater() });
    const result = await h.coordinator.exchange({
      pairingId: PAIRING_ID, installationId: INSTALL_ID, installationIdHash: INSTALL_HASH,
      accessTokenHash: ACCESS_HASH, refreshTokenHash: REFRESH_HASH, now: NOW,
    });
    expect(result.kind).toBe('not_approved');
  });

  it('returns not_found for an unknown pairingId', async () => {
    const h = harness();
    const result = await h.coordinator.exchange({
      pairingId: 'unknown', installationId: INSTALL_ID, installationIdHash: INSTALL_HASH,
      accessTokenHash: ACCESS_HASH, refreshTokenHash: REFRESH_HASH, now: NOW,
    });
    expect(result.kind).toBe('not_found');
  });

  it('returns installation_mismatch when the installationIdHash does not match', async () => {
    const h = harness();
    await approvedPairing(h);
    const result = await h.coordinator.exchange({
      pairingId: PAIRING_ID, installationId: INSTALL_ID, installationIdHash: 'different-hash',
      accessTokenHash: ACCESS_HASH, refreshTokenHash: REFRESH_HASH, now: NOW,
    });
    expect(result.kind).toBe('installation_mismatch');
  });

  it('rejects and does not issue a credential when the installation is already revoked', async () => {
    const h = harness();
    await approvedPairing(h);
    await h.installationRepo.revoke(INSTALL_ID, NOW);
    const result = await h.coordinator.exchange({
      pairingId: PAIRING_ID, installationId: INSTALL_ID, installationIdHash: INSTALL_HASH,
      accessTokenHash: ACCESS_HASH, refreshTokenHash: REFRESH_HASH, now: NOW,
    });
    expect(result.kind).toBe('installation_revoked');
    expect(await h.sessionRepo.get(ACCESS_HASH)).toBeNull();
    expect(await h.refreshRepo.getByHash(REFRESH_HASH)).toBeNull();
    expect((await h.pairingRepo.getById(PAIRING_ID))?.status).toBe('failed');
  });
});

describe('ProductExchangeCoordinator — idempotent replay', () => {
  async function exchangeOnce(h: ReturnType<typeof harness>, now = NOW) {
    return h.coordinator.exchange({
      pairingId: PAIRING_ID, installationId: INSTALL_ID, installationIdHash: INSTALL_HASH,
      accessTokenHash: ACCESS_HASH, refreshTokenHash: REFRESH_HASH, now,
    });
  }

  it('replaying the exact same hash pair succeeds without minting a new credential', async () => {
    const h = harness();
    await approvedPairing(h);
    await exchangeOnce(h);
    const before = await h.refreshRepo.getByHash(REFRESH_HASH);

    const retryTime = new Date(NOW.getTime() + 60_000);
    const result = await exchangeOnce(h, retryTime);
    expect(result.kind).toBe('registered');

    const after = await h.refreshRepo.getByHash(REFRESH_HASH);
    expect(after?.createdAt).toEqual(before?.createdAt); // 作り直されていない(同一doc)
  });

  it('does not re-stamp expiry on replay: refreshTokenExpiresAt stays fixed, accessTokenExpiresInSeconds shrinks with real elapsed time', async () => {
    const h = harness();
    await approvedPairing(h);
    const first = await exchangeOnce(h);
    expect(first.kind).toBe('registered');
    if (first.kind !== 'registered') return;

    const retryTime = new Date(NOW.getTime() + 5 * 60_000); // 5分後にretry
    const second = await exchangeOnce(h, retryTime);
    expect(second.kind).toBe('registered');
    if (second.kind !== 'registered') return;

    expect(second.refreshTokenExpiresAt).toEqual(first.refreshTokenExpiresAt); // 初回確定時のまま
    expect(second.accessTokenExpiresInSeconds).toBeLessThan(first.accessTokenExpiresInSeconds); // 残り時間は減っている
    expect(second.accessTokenExpiresInSeconds).toBeCloseTo(15 * 60 - 5 * 60, 0);
  });

  it('rejects a different hash pair for an already-exchanged pairing (hash_mismatch)', async () => {
    const h = harness();
    await approvedPairing(h);
    await exchangeOnce(h);
    const result = await h.coordinator.exchange({
      pairingId: PAIRING_ID, installationId: INSTALL_ID, installationIdHash: INSTALL_HASH,
      accessTokenHash: OTHER_ACCESS_HASH, refreshTokenHash: OTHER_REFRESH_HASH, now: NOW,
    });
    expect(result.kind).toBe('hash_mismatch');
    // 元のcredentialは無傷のまま
    expect((await h.sessionRepo.get(ACCESS_HASH))?.revokedAt).toBeNull();
  });

  it('rejects replay when the refresh token doc has since been rotated (rotatedAt set)', async () => {
    const h = harness();
    await approvedPairing(h);
    await exchangeOnce(h);
    const refreshDoc = await h.refreshRepo.getByHash(REFRESH_HASH);
    if (!refreshDoc) throw new Error('missing refresh doc');
    // /product/sessions/refresh相当のrotationが後から発生した状況を模す
    await h.refreshRepo.rotate(REFRESH_HASH, {
      refreshTokenHash: 'rotated-hash', installationId: INSTALL_ID, userId: 'user-1',
      familyId: refreshDoc.familyId, generation: 2, now: NOW, expiresAt: tenMinutesLater(),
    });
    const result = await exchangeOnce(h, new Date(NOW.getTime() + 1000));
    expect(result.kind).toBe('internal_inconsistency');
  });

  it('rejects replay when the access token has expired', async () => {
    const h = harness();
    await approvedPairing(h);
    await exchangeOnce(h);
    const wayLater = new Date(NOW.getTime() + 20 * 60_000); // アクセストークンTTL(15分)超過
    const result = await exchangeOnce(h, wayLater);
    expect(result.kind).toBe('internal_inconsistency');
  });

  it('rejects replay when the refresh token has expired', async () => {
    const h = harness();
    await approvedPairing(h);
    await exchangeOnce(h);
    const wayLater = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000); // refresh token TTL(30日)超過
    const result = await exchangeOnce(h, wayLater);
    expect(result.kind).toBe('internal_inconsistency');
  });

  it('rejects replay when the access token has been revoked', async () => {
    const h = harness();
    await approvedPairing(h);
    await exchangeOnce(h);
    await h.sessionRepo.revoke(ACCESS_HASH, NOW);
    const result = await exchangeOnce(h, new Date(NOW.getTime() + 1000));
    expect(result.kind).toBe('internal_inconsistency');
  });
});

describe('ProductExchangeCoordinator — concurrent exchange (same-hash convergence)', () => {
  it('two concurrent exchange calls with the identical candidate both succeed and converge to one credential', async () => {
    const h = harness();
    await approvedPairing(h);
    const params = {
      pairingId: PAIRING_ID, installationId: INSTALL_ID, installationIdHash: INSTALL_HASH,
      accessTokenHash: ACCESS_HASH, refreshTokenHash: REFRESH_HASH, now: NOW,
    };
    const [a, b] = await Promise.all([h.coordinator.exchange(params), h.coordinator.exchange(params)]);
    expect(a.kind).toBe('registered');
    expect(b.kind).toBe('registered');
    // 有効なrefresh token docは1件のみ
    expect(await h.refreshRepo.getByHash(REFRESH_HASH)).not.toBeNull();
    // NOTE: このInMemory実装はシングルスレッドで内部にawaitの分岐点を持たないため、
    // 「片方が新規登録・片方がreplay」という順序の論理的整合性は検証できるが、
    // Firestoreの実際のtransaction再試行(commit競合時の自動リトライ)そのものは
    // この場では再現できない。並行transactionの衝突・自動リトライの正しさは、
    // 設計上はFirestoreのtransaction保証に依拠しており、実環境またはFirestore
    // emulatorでの検証が別途必要(未実施)。
  });

  it('two concurrent exchange calls with different candidates: exactly one wins, the other gets hash_mismatch', async () => {
    const h = harness();
    await approvedPairing(h);
    const [a, b] = await Promise.all([
      h.coordinator.exchange({ pairingId: PAIRING_ID, installationId: INSTALL_ID, installationIdHash: INSTALL_HASH, accessTokenHash: ACCESS_HASH, refreshTokenHash: REFRESH_HASH, now: NOW }),
      h.coordinator.exchange({ pairingId: PAIRING_ID, installationId: INSTALL_ID, installationIdHash: INSTALL_HASH, accessTokenHash: OTHER_ACCESS_HASH, refreshTokenHash: OTHER_REFRESH_HASH, now: NOW }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['hash_mismatch', 'registered']);
    // 勝者のcredentialのみ存在する
    const winnerIsA = a.kind === 'registered';
    const winnerAccessHash = winnerIsA ? ACCESS_HASH : OTHER_ACCESS_HASH;
    const loserAccessHash = winnerIsA ? OTHER_ACCESS_HASH : ACCESS_HASH;
    expect(await h.sessionRepo.get(winnerAccessHash)).not.toBeNull();
    expect(await h.sessionRepo.get(loserAccessHash)).toBeNull();
  });
});
