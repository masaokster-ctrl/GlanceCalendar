import { describe, expect, it } from 'vitest';
import { InMemoryIdempotencyRepository } from '../src/firestore/idempotencyRepository.js';

const BASE_PARAMS = {
  operationId: 'op-1',
  actionType: 'create_event' as const,
  calendarId: 'primary',
  leaseDurationMs: 30_000,
};

describe('InMemoryIdempotencyRepository', () => {
  it('acquires a lease on the first attempt', async () => {
    const repo = new InMemoryIdempotencyRepository();
    const now = new Date('2026-07-21T01:00:00.000Z');
    const result = await repo.acquireLeaseOrGetStatus({
      ...BASE_PARAMS,
      leaseOwner: 'owner-a',
      now,
      expiresAt: new Date(now.getTime() + 1000),
    });

    expect(result.kind).toBe('lease-acquired');
    expect(result.doc.status).toBe('processing');
    expect(result.doc.attemptCount).toBe(1);
  });

  it('only one of two concurrent attempts acquires the lease', async () => {
    const repo = new InMemoryIdempotencyRepository();
    const now = new Date('2026-07-21T01:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 1000);

    const [a, b] = await Promise.all([
      repo.acquireLeaseOrGetStatus({ ...BASE_PARAMS, leaseOwner: 'owner-a', now, expiresAt }),
      repo.acquireLeaseOrGetStatus({ ...BASE_PARAMS, leaseOwner: 'owner-b', now, expiresAt }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['lease-acquired', 'processing']);
  });

  it('does not re-execute once completed and instead returns the completed result', async () => {
    const repo = new InMemoryIdempotencyRepository();
    const now = new Date('2026-07-21T01:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 1000);

    await repo.acquireLeaseOrGetStatus({ ...BASE_PARAMS, leaseOwner: 'owner-a', now, expiresAt });
    await repo.markCompleted({ operationId: 'op-1', googleEventId: 'evt-1', resultCode: 'created', now });

    const result = await repo.acquireLeaseOrGetStatus({ ...BASE_PARAMS, leaseOwner: 'owner-b', now, expiresAt });
    expect(result.kind).toBe('completed');
    expect(result.doc.googleEventId).toBe('evt-1');
  });

  it('does not grant a new lease while an active lease is still processing', async () => {
    const repo = new InMemoryIdempotencyRepository();
    const now = new Date('2026-07-21T01:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 1000);

    await repo.acquireLeaseOrGetStatus({ ...BASE_PARAMS, leaseOwner: 'owner-a', now, expiresAt: new Date(now.getTime() + 30_000) });

    const later = new Date(now.getTime() + 5_000); // まだlease期限内
    const result = await repo.acquireLeaseOrGetStatus({ ...BASE_PARAMS, leaseOwner: 'owner-b', now: later, expiresAt });
    expect(result.kind).toBe('processing');
  });

  it('allows re-acquiring the lease after it has expired', async () => {
    const repo = new InMemoryIdempotencyRepository();
    const now = new Date('2026-07-21T01:00:00.000Z');

    await repo.acquireLeaseOrGetStatus({
      ...BASE_PARAMS,
      leaseOwner: 'owner-a',
      now,
      expiresAt: new Date(now.getTime() + 1000),
    });

    const muchLater = new Date(now.getTime() + 60_000); // leaseDurationMs(30s)を超えて経過
    const result = await repo.acquireLeaseOrGetStatus({
      ...BASE_PARAMS,
      leaseOwner: 'owner-b',
      now: muchLater,
      expiresAt: new Date(muchLater.getTime() + 1000),
    });

    expect(result.kind).toBe('lease-acquired');
    expect(result.doc.leaseOwner).toBe('owner-b');
    expect(result.doc.attemptCount).toBe(2);
  });

  it('marks failed and allows a subsequent retry to acquire a new lease', async () => {
    const repo = new InMemoryIdempotencyRepository();
    const now = new Date('2026-07-21T01:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 1000);

    await repo.acquireLeaseOrGetStatus({ ...BASE_PARAMS, leaseOwner: 'owner-a', now, expiresAt });
    await repo.markFailed({ operationId: 'op-1', sanitizedErrorCode: 'server_error', now });

    const doc = await repo.get('op-1');
    expect(doc?.status).toBe('failed');
    expect(doc?.lastErrorCode).toBe('server_error');

    const retry = await repo.acquireLeaseOrGetStatus({ ...BASE_PARAMS, leaseOwner: 'owner-b', now, expiresAt });
    expect(retry.kind).toBe('lease-acquired');
    expect(retry.doc.attemptCount).toBe(2);
  });

  it('transitions from failed to completed on a successful retry', async () => {
    const repo = new InMemoryIdempotencyRepository();
    const now = new Date('2026-07-21T01:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 1000);

    await repo.acquireLeaseOrGetStatus({ ...BASE_PARAMS, leaseOwner: 'owner-a', now, expiresAt });
    await repo.markFailed({ operationId: 'op-1', sanitizedErrorCode: 'server_error', now });
    await repo.acquireLeaseOrGetStatus({ ...BASE_PARAMS, leaseOwner: 'owner-b', now, expiresAt });
    await repo.markCompleted({ operationId: 'op-1', googleEventId: 'evt-2', resultCode: 'created', now });

    const doc = await repo.get('op-1');
    expect(doc?.status).toBe('completed');
    expect(doc?.googleEventId).toBe('evt-2');
  });
});
