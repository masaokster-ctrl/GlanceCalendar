import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/time/clock.js';
import { InMemoryConversationStateRepository } from '../src/firestore/conversationStateRepository.js';
import { InMemoryIdempotencyRepository } from '../src/firestore/idempotencyRepository.js';
import { FakeCalendarClient } from '../src/calendar/calendarClient.js';
import { createCalendarService } from '../src/calendar/calendarService.js';
import { computeGoogleEventId, computeOperationId } from '../src/calendar/calendarEventId.js';
import { confirmAndCreateEvent } from '../src/services/idempotentEventCreationService.js';
import type { ConversationStateDoc } from '../src/firestore/models.js';

const NOW_ISO = '2026-07-21T01:00:00.000Z';

function buildPendingDoc(overrides: Partial<ConversationStateDoc> = {}): ConversationStateDoc {
  const now = new Date(NOW_ISO);
  const startDateTime = '2026-07-22T15:00:00+09:00';
  const endDateTime = '2026-07-22T16:00:00+09:00';
  const calendarId = 'primary';
  const summary = '接続テスト予定';
  const timeZone = 'Asia/Tokyo';
  const operationId = computeOperationId({ userId: 'single-user', calendarId, summary, startDateTime, endDateTime, timeZone });

  return {
    userId: 'single-user',
    state: 'awaiting_confirmation',
    actionType: 'create_event',
    operationId,
    calendarId,
    event: { summary, startDateTime, endDateTime, timeZone, description: 'Even G2から登録' },
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    version: 1,
    ...overrides,
  };
}

function fastDelay(): (ms: number) => Promise<void> {
  return async () => {};
}

describe('confirmAndCreateEvent', () => {
  it('returns no-pending when there is nothing to confirm', async () => {
    const outcome = await confirmAndCreateEvent(
      {
        clock: fixedClock(NOW_ISO),
        conversationStateRepo: new InMemoryConversationStateRepository(),
        idempotencyRepo: new InMemoryIdempotencyRepository(),
        calendarService: createCalendarService(new FakeCalendarClient()),
      },
      'single-user',
    );
    expect(outcome.kind).toBe('no-pending');
  });

  it('returns expired and clears the pending state when past expiresAt', async () => {
    const conversationStateRepo = new InMemoryConversationStateRepository();
    const clock = fixedClock(NOW_ISO);
    await conversationStateRepo.save(buildPendingDoc({ expiresAt: new Date(Date.parse(NOW_ISO) - 1000) }));

    const outcome = await confirmAndCreateEvent(
      {
        clock,
        conversationStateRepo,
        idempotencyRepo: new InMemoryIdempotencyRepository(),
        calendarService: createCalendarService(new FakeCalendarClient()),
      },
      'single-user',
    );

    expect(outcome.kind).toBe('expired');
    expect(await conversationStateRepo.get('single-user')).toBeNull();
  });

  it('creates the event on first confirmation and clears the pending state', async () => {
    const conversationStateRepo = new InMemoryConversationStateRepository();
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    const fake = new FakeCalendarClient();
    const clock = fixedClock(NOW_ISO);
    const pending = buildPendingDoc();
    await conversationStateRepo.save(pending);

    const outcome = await confirmAndCreateEvent(
      { clock, conversationStateRepo, idempotencyRepo, calendarService: createCalendarService(fake) },
      'single-user',
    );

    expect(outcome.kind).toBe('success');
    expect(outcome.leaseAcquired).toBe(true);
    expect(outcome.reusedCompletedResult).toBe(false);
    expect(outcome.calendarApiOperation).toBe('events.insert');
    expect(fake.insertCallCount).toBe(1);
    expect(await conversationStateRepo.get('single-user')).toBeNull();

    const doc = await idempotencyRepo.get(pending.operationId);
    expect(doc?.status).toBe('completed');
  });

  it('treats a Google 409 duplicate-id response as success after confirming via events.get', async () => {
    const conversationStateRepo = new InMemoryConversationStateRepository();
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    const fake = new FakeCalendarClient();
    const clock = fixedClock(NOW_ISO);
    const pending = buildPendingDoc();

    // Calendar側には既に同じevent IDで登録済みという状況を再現する
    const eventId = computeGoogleEventId(pending.operationId);
    await fake.insertEvent({
      calendarId: pending.calendarId,
      eventId,
      summary: pending.event.summary,
      startDateTime: pending.event.startDateTime,
      endDateTime: pending.event.endDateTime,
      timeZone: pending.event.timeZone,
      description: pending.event.description,
      operationId: pending.operationId,
    });
    fake.insertCallCount = 0; // ここまでの準備呼び出しはカウントしない

    await conversationStateRepo.save(pending);

    const outcome = await confirmAndCreateEvent(
      { clock, conversationStateRepo, idempotencyRepo, calendarService: createCalendarService(fake) },
      'single-user',
    );

    expect(outcome.kind).toBe('success');
    expect(outcome.reusedCompletedResult).toBe(true);
    expect(outcome.calendarApiOperation).toBe('events.get');
    expect(outcome.calendarApiResultCode).toBe('already_exists');

    const doc = await idempotencyRepo.get(pending.operationId);
    expect(doc?.status).toBe('completed');
  });

  it('marks failed on a temporary error and keeps the pending state for retry', async () => {
    const conversationStateRepo = new InMemoryConversationStateRepository();
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    const fake = new FakeCalendarClient();
    fake.nextInsertError = () => {
      const err = new Error('temporary') as Error & { code: number };
      err.code = 503;
      throw err;
    };
    const clock = fixedClock(NOW_ISO);
    const pending = buildPendingDoc();
    await conversationStateRepo.save(pending);

    const outcome = await confirmAndCreateEvent(
      { clock, conversationStateRepo, idempotencyRepo, calendarService: createCalendarService(fake) },
      'single-user',
    );

    expect(outcome.kind).toBe('temporary-error');
    expect(outcome.sanitizedErrorCode).toBe('server_error');
    // 一時エラー時は確認待ち状態を再試行可能な形で残す
    expect(await conversationStateRepo.get('single-user')).not.toBeNull();

    const doc = await idempotencyRepo.get(pending.operationId);
    expect(doc?.status).toBe('failed');
  });

  it('succeeds on retry after a prior temporary failure', async () => {
    const conversationStateRepo = new InMemoryConversationStateRepository();
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    const fake = new FakeCalendarClient();
    fake.nextInsertError = () => {
      const err = new Error('temporary') as Error & { code: number };
      err.code = 503;
      throw err;
    };
    const clock = fixedClock(NOW_ISO);
    const pending = buildPendingDoc();
    await conversationStateRepo.save(pending);

    const deps = { clock, conversationStateRepo, idempotencyRepo, calendarService: createCalendarService(fake) };
    const first = await confirmAndCreateEvent(deps, 'single-user');
    expect(first.kind).toBe('temporary-error');

    await conversationStateRepo.save(pending); // 再度「はい」相当。pendingは既に残っているため置換
    const second = await confirmAndCreateEvent(deps, 'single-user');

    expect(second.kind).toBe('success');
    // 1回目(失敗)+2回目(成功)で計2回 insertEvent が呼ばれる想定
    expect(fake.insertCallCount).toBe(2);
  });

  it('returns an auth-error outcome for authentication failures', async () => {
    const conversationStateRepo = new InMemoryConversationStateRepository();
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    const fake = new FakeCalendarClient();
    fake.nextInsertError = () => {
      const err = new Error('invalid_grant') as Error & { code: number };
      err.code = 401;
      throw err;
    };
    const clock = fixedClock(NOW_ISO);
    const pending = buildPendingDoc();
    await conversationStateRepo.save(pending);

    const outcome = await confirmAndCreateEvent(
      { clock, conversationStateRepo, idempotencyRepo, calendarService: createCalendarService(fake) },
      'single-user',
    );

    expect(outcome.kind).toBe('auth-error');
    expect(outcome.sanitizedErrorCode).toBe('auth_invalid_grant');
  });

  it('does not call Calendar API at all when the transaction only observes an active lease', async () => {
    const conversationStateRepo = new InMemoryConversationStateRepository();
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    const fake = new FakeCalendarClient();
    const clock = fixedClock(NOW_ISO);
    const pending = buildPendingDoc();

    // 先に他のプロセスがleaseを取得している状況を再現(30秒有効)
    await idempotencyRepo.acquireLeaseOrGetStatus({
      operationId: pending.operationId,
      actionType: 'create_event',
      calendarId: pending.calendarId,
      leaseOwner: 'other-instance',
      leaseDurationMs: 30_000,
      now: new Date(NOW_ISO),
      expiresAt: new Date(Date.parse(NOW_ISO) + 30 * 24 * 60 * 60 * 1000),
    });
    await conversationStateRepo.save(pending);

    const outcome = await confirmAndCreateEvent(
      {
        clock,
        conversationStateRepo,
        idempotencyRepo,
        calendarService: createCalendarService(fake),
        delayFn: fastDelay(),
      },
      'single-user',
    );

    expect(outcome.kind).toBe('still-processing');
    expect(fake.insertCallCount).toBe(0);
  });

  it('exercises only one real Calendar insert when two confirmations race concurrently', async () => {
    const conversationStateRepo = new InMemoryConversationStateRepository();
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    const fake = new FakeCalendarClient();
    const clock = fixedClock(NOW_ISO);
    const pending = buildPendingDoc();
    await conversationStateRepo.save(pending);

    const deps = {
      clock,
      conversationStateRepo,
      idempotencyRepo,
      calendarService: createCalendarService(fake),
      delayFn: fastDelay(),
    };

    const [a, b] = await Promise.all([confirmAndCreateEvent(deps, 'single-user'), confirmAndCreateEvent(deps, 'single-user')]);

    expect(fake.insertCallCount).toBeLessThanOrEqual(1);
    expect([a.kind, b.kind].every((k) => k === 'success' || k === 'still-processing')).toBe(true);
  });
});
