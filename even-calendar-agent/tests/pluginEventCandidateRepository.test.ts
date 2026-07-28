import { describe, expect, it } from 'vitest';
import { InMemoryPluginEventCandidateRepository } from '../src/firestore/pluginEventCandidateRepository.js';

const NOW = new Date('2026-07-22T05:00:00Z');

function baseParams(overrides: Partial<Parameters<InMemoryPluginEventCandidateRepository['create']>[0]> = {}) {
  return {
    candidateId: 'c1',
    sessionHash: 'session-hash',
    installIdHash: 'install-hash',
    title: '打ち合わせ',
    startLocal: '2026-07-23T15:00:00',
    endLocal: '2026-07-23T16:00:00',
    timeZone: 'Asia/Tokyo',
    allDay: false,
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    analysisRequestIdHash: 'req-hash',
    ...overrides,
  };
}

describe('InMemoryPluginEventCandidateRepository', () => {
  it('creates a candidate with status=pending', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    await repo.create(baseParams());
    const doc = await repo.get('c1');
    expect(doc?.status).toBe('pending');
    expect(doc?.consumedAt).toBeNull();
    expect(doc?.googleEventId).toBeNull();
  });

  it('returns null for an unknown candidateId', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    expect(await repo.get('unknown')).toBeNull();
  });

  it('acquireLease returns not_found for an unknown candidateId', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    const result = await repo.acquireLease({ candidateId: 'unknown', leaseOwner: 'owner', leaseDurationMs: 1000, now: NOW });
    expect(result.kind).toBe('not_found');
  });

  it('acquireLease returns expired when the TTL has passed and status is still pending', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    await repo.create(baseParams({ expiresAt: new Date(NOW.getTime() - 1000) }));
    const result = await repo.acquireLease({ candidateId: 'c1', leaseOwner: 'owner', leaseDurationMs: 1000, now: NOW });
    expect(result.kind).toBe('expired');
  });

  it('acquireLease transitions pending to creating and returns lease_acquired', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    await repo.create(baseParams());
    const result = await repo.acquireLease({ candidateId: 'c1', leaseOwner: 'owner-1', leaseDurationMs: 30_000, now: NOW });
    expect(result.kind).toBe('lease_acquired');
    if (result.kind === 'lease_acquired') {
      expect(result.doc.status).toBe('creating');
      expect(result.doc.leaseOwner).toBe('owner-1');
    }
    const stored = await repo.get('c1');
    expect(stored?.status).toBe('creating');
  });

  it('acquireLease returns lease_active when another lease is still valid', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    await repo.create(baseParams());
    await repo.acquireLease({ candidateId: 'c1', leaseOwner: 'owner-1', leaseDurationMs: 30_000, now: NOW });
    const second = await repo.acquireLease({
      candidateId: 'c1',
      leaseOwner: 'owner-2',
      leaseDurationMs: 30_000,
      now: new Date(NOW.getTime() + 1000),
    });
    expect(second.kind).toBe('lease_active');
  });

  it('acquireLease allows re-acquisition once a prior lease has expired', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    await repo.create(baseParams());
    await repo.acquireLease({ candidateId: 'c1', leaseOwner: 'owner-1', leaseDurationMs: 1000, now: NOW });
    const later = new Date(NOW.getTime() + 5000); // 元のleaseはとっくに切れている
    const second = await repo.acquireLease({ candidateId: 'c1', leaseOwner: 'owner-2', leaseDurationMs: 30_000, now: later });
    expect(second.kind).toBe('lease_acquired');
  });

  it('acquireLease returns already_completed after markCompleted', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    await repo.create(baseParams());
    await repo.acquireLease({ candidateId: 'c1', leaseOwner: 'owner-1', leaseDurationMs: 30_000, now: NOW });
    await repo.markCompleted('c1', 'google-event-id', NOW);
    const result = await repo.acquireLease({ candidateId: 'c1', leaseOwner: 'owner-2', leaseDurationMs: 30_000, now: NOW });
    expect(result.kind).toBe('already_completed');
    if (result.kind === 'already_completed') {
      expect(result.doc.googleEventId).toBe('google-event-id');
    }
  });

  it('acquireLease returns already_failed after markFailed, carrying the sanitizedErrorCode', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    await repo.create(baseParams());
    await repo.acquireLease({ candidateId: 'c1', leaseOwner: 'owner-1', leaseDurationMs: 30_000, now: NOW });
    await repo.markFailed('c1', 'server_error', NOW);
    const result = await repo.acquireLease({ candidateId: 'c1', leaseOwner: 'owner-2', leaseDurationMs: 30_000, now: NOW });
    expect(result.kind).toBe('already_failed');
    if (result.kind === 'already_failed') {
      expect(result.doc.sanitizedErrorCode).toBe('server_error');
    }
  });

  it('never stores audio, transcription, or PCM fields (type-level + runtime field check)', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    await repo.create(baseParams());
    const doc = await repo.get('c1');
    const keys = Object.keys(doc ?? {});
    expect(keys).not.toContain('audio');
    expect(keys).not.toContain('pcm');
    expect(keys).not.toContain('wav');
    expect(keys).not.toContain('transcription');
    expect(keys.sort()).toEqual(
      [
        'candidateId',
        'sessionHash',
        'installIdHash',
        'title',
        'startLocal',
        'endLocal',
        'timeZone',
        'allDay',
        'startDate',
        'endDateExclusive',
        'status',
        'createdAt',
        'expiresAt',
        'consumedAt',
        'analysisRequestIdHash',
        'operationId',
        'googleEventId',
        'sanitizedErrorCode',
        'leaseOwner',
        'leaseExpiresAt',
      ].sort(),
    );
  });

  it('defaults startDate/endDateExclusive to null when not provided (backward compatibility for timed candidates)', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    await repo.create(baseParams());
    const doc = await repo.get('c1');
    expect(doc?.startDate).toBeNull();
    expect(doc?.endDateExclusive).toBeNull();
  });

  it('round-trips an all-day candidate with startDate/endDateExclusive and null startLocal/endLocal', async () => {
    const repo = new InMemoryPluginEventCandidateRepository();
    await repo.create(
      baseParams({
        startLocal: null,
        endLocal: null,
        allDay: true,
        startDate: '2026-07-23',
        endDateExclusive: '2026-07-25',
      }),
    );
    const doc = await repo.get('c1');
    expect(doc?.allDay).toBe(true);
    expect(doc?.startLocal).toBeNull();
    expect(doc?.endLocal).toBeNull();
    expect(doc?.startDate).toBe('2026-07-23');
    expect(doc?.endDateExclusive).toBe('2026-07-25');
  });
});
