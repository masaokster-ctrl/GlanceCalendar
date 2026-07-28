import { describe, expect, it } from 'vitest';
import { InMemoryPluginConversationRepository, MAX_TURNS } from '../src/firestore/pluginConversationRepository.js';

const NOW = new Date('2026-07-22T05:00:00Z');

function baseParams(overrides: Partial<Parameters<InMemoryPluginConversationRepository['create']>[0]> = {}) {
  return {
    conversationId: 'conv-1',
    sessionHash: 'session-hash',
    installIdHash: 'install-hash',
    partialCandidate: {
      title: null,
      dateLocal: null,
      startTimeLocal: null,
      durationMinutes: null,
      startLocal: null,
      endLocal: null,
      timeZone: 'Asia/Tokyo',
      allDay: false,
      endDateLocal: null,
      allDaySignal: null,
    },
    missingField: 'start_time' as const,
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    ...overrides,
  };
}

describe('InMemoryPluginConversationRepository', () => {
  it('creates a conversation with status=awaiting_clarification and turnCount=0', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams());
    const doc = await repo.get('conv-1');
    expect(doc?.status).toBe('awaiting_clarification');
    expect(doc?.turnCount).toBe(0);
    expect(doc?.missingField).toBe('start_time');
  });

  it('MAX_TURNS is 3', () => {
    expect(MAX_TURNS).toBe(3);
  });

  it('returns null for an unknown conversationId', async () => {
    const repo = new InMemoryPluginConversationRepository();
    expect(await repo.get('unknown')).toBeNull();
  });

  it('acquireFollowupLease returns not_found for an unknown conversationId', async () => {
    const repo = new InMemoryPluginConversationRepository();
    const result = await repo.acquireFollowupLease({ conversationId: 'unknown', leaseOwner: 'o', leaseDurationMs: 1000, now: NOW });
    expect(result.kind).toBe('not_found');
  });

  it('acquireFollowupLease returns expired once the TTL has passed', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams({ expiresAt: new Date(NOW.getTime() - 1000) }));
    const result = await repo.acquireFollowupLease({ conversationId: 'conv-1', leaseOwner: 'o', leaseDurationMs: 1000, now: NOW });
    expect(result.kind).toBe('expired');
  });

  it('acquireFollowupLease transitions awaiting_clarification to analyzing_followup', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams());
    const result = await repo.acquireFollowupLease({ conversationId: 'conv-1', leaseOwner: 'owner-1', leaseDurationMs: 30_000, now: NOW });
    expect(result.kind).toBe('lease_acquired');
    const stored = await repo.get('conv-1');
    expect(stored?.status).toBe('analyzing_followup');
  });

  it('acquireFollowupLease returns lease_active when another lease is still valid', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams());
    await repo.acquireFollowupLease({ conversationId: 'conv-1', leaseOwner: 'owner-1', leaseDurationMs: 30_000, now: NOW });
    const second = await repo.acquireFollowupLease({
      conversationId: 'conv-1',
      leaseOwner: 'owner-2',
      leaseDurationMs: 30_000,
      now: new Date(NOW.getTime() + 1000),
    });
    expect(second.kind).toBe('lease_active');
  });

  it('acquireFollowupLease returns wrong_status for a completed or cancelled conversation', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams());
    await repo.markCompleted('conv-1', NOW);
    const result = await repo.acquireFollowupLease({ conversationId: 'conv-1', leaseOwner: 'o', leaseDurationMs: 1000, now: NOW });
    expect(result.kind).toBe('wrong_status');
  });

  it('acquireFollowupLease returns max_turns_reached once turnCount reaches MAX_TURNS', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams());
    // turnCountを人為的にMAX_TURNSまで進める
    for (let i = 0; i < MAX_TURNS; i += 1) {
      await repo.recordNextClarification({
        conversationId: 'conv-1',
        partialCandidate: {
          title: null,
          dateLocal: null,
          startTimeLocal: null,
          durationMinutes: null,
          startLocal: null,
          endLocal: null,
          timeZone: 'Asia/Tokyo',
          allDay: false,
          endDateLocal: null,
          allDaySignal: null,
        },
        missingField: 'start_time',
        now: NOW,
      });
    }
    const result = await repo.acquireFollowupLease({ conversationId: 'conv-1', leaseOwner: 'o', leaseDurationMs: 1000, now: NOW });
    expect(result.kind).toBe('max_turns_reached');
  });

  it('recordNextClarification increments turnCount and returns to awaiting_clarification', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams());
    await repo.acquireFollowupLease({ conversationId: 'conv-1', leaseOwner: 'o', leaseDurationMs: 1000, now: NOW });
    await repo.recordNextClarification({
      conversationId: 'conv-1',
      partialCandidate: {
        title: 'x',
        dateLocal: null,
        startTimeLocal: null,
        durationMinutes: null,
        startLocal: null,
        endLocal: null,
        timeZone: 'Asia/Tokyo',
        allDay: false,
        endDateLocal: null,
        allDaySignal: null,
      },
      missingField: 'date',
      now: NOW,
    });
    const doc = await repo.get('conv-1');
    expect(doc?.status).toBe('awaiting_clarification');
    expect(doc?.turnCount).toBe(1);
    expect(doc?.missingField).toBe('date');
    expect(doc?.partialCandidate.title).toBe('x');
  });

  it('releaseLeaseBackToAwaiting does not increment turnCount', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams());
    await repo.acquireFollowupLease({ conversationId: 'conv-1', leaseOwner: 'o', leaseDurationMs: 1000, now: NOW });
    await repo.releaseLeaseBackToAwaiting('conv-1', NOW);
    const doc = await repo.get('conv-1');
    expect(doc?.status).toBe('awaiting_clarification');
    expect(doc?.turnCount).toBe(0);
  });

  it('cancelActiveForSession cancels only active conversations for the matching session', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams({ conversationId: 'conv-a', sessionHash: 'session-A' }));
    await repo.create(baseParams({ conversationId: 'conv-b', sessionHash: 'session-B' }));
    await repo.cancelActiveForSession('session-A', NOW);

    const a = await repo.get('conv-a');
    const b = await repo.get('conv-b');
    expect(a?.status).toBe('cancelled');
    expect(b?.status).toBe('awaiting_clarification');
  });

  it('cancelActiveForSession does not touch already-completed conversations', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams());
    await repo.markCompleted('conv-1', NOW);
    await repo.cancelActiveForSession('session-hash', NOW);
    const doc = await repo.get('conv-1');
    expect(doc?.status).toBe('completed');
  });

  it('treats a legacy partialCandidate (missing dateLocal) as wrong_status so the client starts over', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams());
    // デプロイ切り替え直後を再現: 旧スキーマ相当(dateLocal等が無い)ドキュメントに書き換える。
    const legacyPartialCandidate = { title: null, startLocal: null, endLocal: null, timeZone: 'Asia/Tokyo', allDay: false };
    await repo.create({
      ...baseParams(),
      // @ts-expect-error 意図的に旧形式(dateLocal等を持たない)partialCandidateを注入する
      partialCandidate: legacyPartialCandidate,
    });
    const result = await repo.acquireFollowupLease({ conversationId: 'conv-1', leaseOwner: 'o', leaseDurationMs: 1000, now: NOW });
    expect(result.kind).toBe('wrong_status');
  });

  it('never stores fields for audio, transcription, or full question text', async () => {
    const repo = new InMemoryPluginConversationRepository();
    await repo.create(baseParams());
    const doc = await repo.get('conv-1');
    const keys = Object.keys(doc ?? {});
    expect(keys).not.toContain('audio');
    expect(keys).not.toContain('transcription');
    expect(keys).not.toContain('clarificationQuestion');
    expect(keys.sort()).toEqual(
      [
        'conversationId',
        'sessionHash',
        'installIdHash',
        'turnCount',
        'status',
        'partialCandidate',
        'missingField',
        'clarificationQuestionCode',
        'createdAt',
        'updatedAt',
        'expiresAt',
        'completedAt',
        'cancelledAt',
        'lastRequestIdHash',
        'leaseOwner',
        'leaseExpiresAt',
      ].sort(),
    );
  });
});
