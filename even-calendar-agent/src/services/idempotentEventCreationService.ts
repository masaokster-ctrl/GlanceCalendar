import { randomUUID } from 'node:crypto';
import type { Clock } from '../time/clock.js';
import type { ConversationStateRepository } from '../firestore/conversationStateRepository.js';
import type { IdempotencyRepository } from '../firestore/idempotencyRepository.js';
import type { IdempotencyStatus } from '../firestore/models.js';
import type { CalendarService } from '../calendar/calendarService.js';
import { computeGoogleEventId } from '../calendar/calendarEventId.js';
import { sanitizeError } from '../security/sanitizedError.js';
import { delay as defaultDelay, type DelayFn } from '../utils/delay.js';

const LEASE_DURATION_MS = 30_000;
const IDEMPOTENCY_RETENTION_DAYS = 30;
const POLL_INTERVAL_MS = 300;
const POLL_MAX_WAIT_MS = 2500;

export type ConfirmOutcomeKind =
  | 'no-pending'
  | 'expired'
  | 'still-processing'
  | 'success'
  | 'temporary-error'
  | 'auth-error';

/** operationId・event IDなどの生値は含めない。ログへそのまま出力できる安全な結果だけを返す。 */
export interface ConfirmCreateEventOutcome {
  kind: ConfirmOutcomeKind;
  leaseAcquired: boolean;
  reusedCompletedResult: boolean;
  idempotencyStatus: IdempotencyStatus | null;
  calendarApiOperation: 'events.insert' | 'events.get' | null;
  calendarApiResultCode: string | null;
  sanitizedErrorCode: string | null;
}

export interface IdempotentEventCreationDeps {
  clock: Clock;
  conversationStateRepo: ConversationStateRepository;
  idempotencyRepo: IdempotencyRepository;
  calendarService: CalendarService;
  delayFn?: DelayFn;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function noOpOutcome(kind: ConfirmOutcomeKind): ConfirmCreateEventOutcome {
  return {
    kind,
    leaseAcquired: false,
    reusedCompletedResult: false,
    idempotencyStatus: null,
    calendarApiOperation: null,
    calendarApiResultCode: null,
    sanitizedErrorCode: null,
  };
}

/**
 * 確認待ちの固定予定をGoogle Calendarへ冪等に登録する。
 * Firestoreトランザクション内でCalendar APIを呼ばない設計(トランザクションはacquireLeaseOrGetStatus内に閉じる)。
 */
export async function confirmAndCreateEvent(
  deps: IdempotentEventCreationDeps,
  userId: string,
): Promise<ConfirmCreateEventOutcome> {
  const pending = await deps.conversationStateRepo.get(userId);
  if (!pending || pending.state !== 'awaiting_confirmation') {
    return noOpOutcome('no-pending');
  }

  const now = deps.clock.now();
  if (pending.expiresAt.getTime() < now.getTime()) {
    await deps.conversationStateRepo.clear(userId);
    return noOpOutcome('expired');
  }

  const leaseOwner = randomUUID();
  const leaseResult = await deps.idempotencyRepo.acquireLeaseOrGetStatus({
    operationId: pending.operationId,
    actionType: pending.actionType,
    calendarId: pending.calendarId,
    leaseOwner,
    leaseDurationMs: LEASE_DURATION_MS,
    now,
    expiresAt: addDays(now, IDEMPOTENCY_RETENTION_DAYS),
  });

  if (leaseResult.kind === 'completed') {
    await deps.conversationStateRepo.clear(userId);
    return {
      kind: 'success',
      leaseAcquired: false,
      reusedCompletedResult: true,
      idempotencyStatus: 'completed',
      calendarApiOperation: null,
      calendarApiResultCode: leaseResult.doc.resultCode,
      sanitizedErrorCode: null,
    };
  }

  if (leaseResult.kind === 'processing') {
    const completedDoc = await pollForCompletion(deps, pending.operationId);
    if (completedDoc) {
      await deps.conversationStateRepo.clear(userId);
      return {
        kind: 'success',
        leaseAcquired: false,
        reusedCompletedResult: true,
        idempotencyStatus: 'completed',
        calendarApiOperation: null,
        calendarApiResultCode: completedDoc.resultCode,
        sanitizedErrorCode: null,
      };
    }
    return {
      kind: 'still-processing',
      leaseAcquired: false,
      reusedCompletedResult: false,
      idempotencyStatus: 'processing',
      calendarApiOperation: null,
      calendarApiResultCode: null,
      sanitizedErrorCode: null,
    };
  }

  // lease-acquired: Firestoreトランザクションの外でCalendar APIを呼ぶ
  const eventId = computeGoogleEventId(pending.operationId);

  try {
    const result = await deps.calendarService.createEvent({
      calendarId: pending.calendarId,
      eventId,
      summary: pending.event.summary,
      startDateTime: pending.event.startDateTime,
      endDateTime: pending.event.endDateTime,
      timeZone: pending.event.timeZone,
      description: pending.event.description,
      operationId: pending.operationId,
    });

    await deps.idempotencyRepo.markCompleted({
      operationId: pending.operationId,
      googleEventId: result.eventId,
      resultCode: 'created',
      now: deps.clock.now(),
    });
    await deps.conversationStateRepo.clear(userId);

    return {
      kind: 'success',
      leaseAcquired: true,
      reusedCompletedResult: false,
      idempotencyStatus: 'completed',
      calendarApiOperation: 'events.insert',
      calendarApiResultCode: 'created',
      sanitizedErrorCode: null,
    };
  } catch (err) {
    const sanitizedCode = sanitizeError(err);

    if (sanitizedCode === 'duplicate_id') {
      const existing = await deps.calendarService.getEvent(pending.calendarId, eventId);
      if (existing) {
        await deps.idempotencyRepo.markCompleted({
          operationId: pending.operationId,
          googleEventId: existing.eventId,
          resultCode: 'already_exists',
          now: deps.clock.now(),
        });
        await deps.conversationStateRepo.clear(userId);

        return {
          kind: 'success',
          leaseAcquired: true,
          reusedCompletedResult: true,
          idempotencyStatus: 'completed',
          calendarApiOperation: 'events.get',
          calendarApiResultCode: 'already_exists',
          sanitizedErrorCode: null,
        };
      }
    }

    await deps.idempotencyRepo.markFailed({
      operationId: pending.operationId,
      sanitizedErrorCode: sanitizedCode,
      now: deps.clock.now(),
    });

    const kind: ConfirmOutcomeKind =
      sanitizedCode === 'auth_invalid_grant' || sanitizedCode === 'auth_forbidden' ? 'auth-error' : 'temporary-error';

    return {
      kind,
      leaseAcquired: true,
      reusedCompletedResult: false,
      idempotencyStatus: 'failed',
      calendarApiOperation: 'events.insert',
      calendarApiResultCode: null,
      sanitizedErrorCode: sanitizedCode,
    };
  }
}

async function pollForCompletion(
  deps: IdempotentEventCreationDeps,
  operationId: string,
): Promise<{ resultCode: string | null } | null> {
  const delayFn = deps.delayFn ?? defaultDelay;
  const attempts = Math.ceil(POLL_MAX_WAIT_MS / POLL_INTERVAL_MS);

  for (let i = 0; i < attempts; i += 1) {
    await delayFn(POLL_INTERVAL_MS);
    const doc = await deps.idempotencyRepo.get(operationId);
    if (doc && doc.status === 'completed') {
      return { resultCode: doc.resultCode };
    }
  }

  return null;
}
