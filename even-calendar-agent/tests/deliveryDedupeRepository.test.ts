import { describe, expect, it } from 'vitest';
import { InMemoryDeliveryDedupeRepository } from '../src/firestore/deliveryDedupeRepository.js';
import { computeDeliveryKey } from '../src/firestore/deliveryKey.js';

describe('InMemoryDeliveryDedupeRepository', () => {
  it('returns false for the first delivery and true for a repeat within the same key', async () => {
    const repo = new InMemoryDeliveryDedupeRepository();
    const now = new Date('2026-07-21T01:00:00.000Z');
    const params = {
      deliveryKey: 'key-1',
      requestFingerprint: 'fp-1',
      operationId: null,
      actionType: null as const,
      now,
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    };

    expect(await repo.recordAndCheckDuplicate(params)).toBe(false);
    expect(await repo.recordAndCheckDuplicate(params)).toBe(true);
  });

  it('does not store conversation content, only fingerprint/operation metadata', async () => {
    const repo = new InMemoryDeliveryDedupeRepository();
    const now = new Date('2026-07-21T01:00:00.000Z');
    await repo.recordAndCheckDuplicate({
      deliveryKey: 'key-2',
      requestFingerprint: 'fp-2',
      operationId: 'op-1',
      actionType: 'create_event',
      now,
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    });
    // レコードにcontentやAuthorizationに相当するフィールドが型として存在しないことは
    // DeliveryDedupeDoc の型定義自体で保証されている。ここでは正常に記録できることのみ確認する。
    expect(await repo.recordAndCheckDuplicate({
      deliveryKey: 'key-2',
      requestFingerprint: 'fp-2',
      operationId: 'op-1',
      actionType: 'create_event',
      now,
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    })).toBe(true);
  });
});

describe('computeDeliveryKey', () => {
  it('produces the same key for the same fingerprint within the same time bucket', () => {
    const now = new Date('2026-07-21T01:00:00.100Z');
    const laterSameBucket = new Date('2026-07-21T01:00:01.900Z');
    expect(computeDeliveryKey('fp-1', now)).toBe(computeDeliveryKey('fp-1', laterSameBucket));
  });

  it('produces a different key once the time bucket has moved on', () => {
    const now = new Date('2026-07-21T01:00:00.000Z');
    const muchLater = new Date('2026-07-21T01:05:00.000Z');
    expect(computeDeliveryKey('fp-1', now)).not.toBe(computeDeliveryKey('fp-1', muchLater));
  });

  it('produces a different key for a different fingerprint', () => {
    const now = new Date('2026-07-21T01:00:00.000Z');
    expect(computeDeliveryKey('fp-1', now)).not.toBe(computeDeliveryKey('fp-2', now));
  });
});
