import { describe, expect, it } from 'vitest';
import { InMemoryProductDeviceRefreshTokenRepository } from '../src/product/productDeviceRefreshTokenRepository.js';

const NOW = new Date('2026-07-23T05:00:00Z');
const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = 'family-1';

function thirtyDaysLater(from: Date = NOW): Date {
  return new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
}

describe('ProductDeviceRefreshTokenRepository — create/lookup', () => {
  it('creates a refresh token record retrievable by hash', async () => {
    const repo = new InMemoryProductDeviceRefreshTokenRepository();
    await repo.create({
      refreshTokenHash: 'hash-1',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 1,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });
    const doc = await repo.getByHash('hash-1');
    expect(doc?.installationId).toBe(INSTALL_ID);
    expect(doc?.generation).toBe(1);
    expect(doc?.rotatedAt).toBeNull();
    expect(doc?.revokedAt).toBeNull();
  });
});

describe('ProductDeviceRefreshTokenRepository — rotate (rotation + reuse detection)', () => {
  it('rotates an active token: old becomes rotated, new is created in the same family with generation+1', async () => {
    const repo = new InMemoryProductDeviceRefreshTokenRepository();
    await repo.create({
      refreshTokenHash: 'hash-1',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 1,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });

    const result = await repo.rotate('hash-1', {
      refreshTokenHash: 'hash-2',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 2,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });

    expect(result.kind).toBe('rotated');
    const oldDoc = await repo.getByHash('hash-1');
    expect(oldDoc?.rotatedAt).toEqual(NOW);
    expect(oldDoc?.replacedByHash).toBe('hash-2');
    const newDoc = await repo.getByHash('hash-2');
    expect(newDoc?.generation).toBe(2);
    expect(newDoc?.familyId).toBe(FAMILY_ID);
  });

  it('returns reuse_detected when an already-rotated (consumed) token is reused', async () => {
    const repo = new InMemoryProductDeviceRefreshTokenRepository();
    await repo.create({
      refreshTokenHash: 'hash-1',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 1,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });
    await repo.rotate('hash-1', {
      refreshTokenHash: 'hash-2',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 2,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });

    // hash-1 is already rotated; reusing it again is a compromise signal
    const reuseResult = await repo.rotate('hash-1', {
      refreshTokenHash: 'hash-3',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 3,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });
    expect(reuseResult).toEqual({ kind: 'reuse_detected', familyId: FAMILY_ID });
    // hash-3 must not have been created as a side effect of a rejected rotate
    expect(await repo.getByHash('hash-3')).toBeNull();
  });

  it('returns not_found for an unknown old hash', async () => {
    const repo = new InMemoryProductDeviceRefreshTokenRepository();
    const result = await repo.rotate('unknown-hash', {
      refreshTokenHash: 'hash-2',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 2,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('returns expired when the old token has passed its expiresAt', async () => {
    const repo = new InMemoryProductDeviceRefreshTokenRepository();
    await repo.create({
      refreshTokenHash: 'hash-1',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 1,
      now: NOW,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    const result = await repo.rotate('hash-1', {
      refreshTokenHash: 'hash-2',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 2,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });
    expect(result).toEqual({ kind: 'expired' });
  });

  it('returns revoked when the old token has already been revoked', async () => {
    const repo = new InMemoryProductDeviceRefreshTokenRepository();
    await repo.create({
      refreshTokenHash: 'hash-1',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 1,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });
    await repo.revokeFamily(FAMILY_ID, NOW);
    const result = await repo.rotate('hash-1', {
      refreshTokenHash: 'hash-2',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 2,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });
    expect(result).toEqual({ kind: 'revoked' });
  });
});

describe('ProductDeviceRefreshTokenRepository — revokeFamily', () => {
  it('revokes every token sharing the same familyId, across generations', async () => {
    const repo = new InMemoryProductDeviceRefreshTokenRepository();
    await repo.create({
      refreshTokenHash: 'hash-1',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 1,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });
    await repo.rotate('hash-1', {
      refreshTokenHash: 'hash-2',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: FAMILY_ID,
      generation: 2,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });
    await repo.revokeFamily(FAMILY_ID, NOW);
    expect((await repo.getByHash('hash-1'))?.revokedAt).toEqual(NOW);
    expect((await repo.getByHash('hash-2'))?.revokedAt).toEqual(NOW);
  });

  it('does not revoke tokens belonging to a different family', async () => {
    const repo = new InMemoryProductDeviceRefreshTokenRepository();
    await repo.create({
      refreshTokenHash: 'hash-other',
      installationId: INSTALL_ID,
      userId: 'user-1',
      familyId: 'other-family',
      generation: 1,
      now: NOW,
      expiresAt: thirtyDaysLater(),
    });
    await repo.revokeFamily(FAMILY_ID, NOW);
    expect((await repo.getByHash('hash-other'))?.revokedAt).toBeNull();
  });
});
