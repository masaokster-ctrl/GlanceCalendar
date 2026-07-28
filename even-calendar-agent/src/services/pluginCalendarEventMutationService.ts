import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Clock } from '../time/clock.js';
import { TOKYO_ZONE, toRfc3339, toTokyoLocalFromIso } from '../time/tokyoDateTime.js';
import type { CalendarService } from '../calendar/calendarService.js';
import type { CalendarEventFullDetail, EventTimingField } from '../calendar/calendarClient.js';
import { isNotFoundError } from '../calendar/calendarClient.js';
import { sanitizeError } from '../security/sanitizedError.js';
import { classifyProductCalendarError } from '../product/productCalendarErrorClassifier.js';
import type { IdempotencyRepository } from '../firestore/idempotencyRepository.js';

const LEASE_DURATION_MS = 30_000;
const IDEMPOTENCY_RETENTION_DAYS = 30;

export interface UpdateEventRequestFields {
  title?: string;
  location?: string;
  description?: string;
  startLocal?: string;
  endLocal?: string;
  allDay?: boolean;
  startDate?: string;
  endDateExclusive?: string;
}

export type MutationOutcomeKind =
  | 'success'
  | 'already_processing'
  | 'not_found'
  | 'invalid_range'
  | 'conflict'
  | 'oauth_not_connected'
  | 'timeout'
  | 'calendar_error';

/** googleEventId以外の予定内容は一切含まない。呼び出し側でも保持・ログ出力しないこと。 */
export interface MutationOutcome {
  kind: MutationOutcomeKind;
  eventId: string | null;
  leaseAcquired: boolean;
  reusedCompletedResult: boolean;
  sanitizedErrorCode: string | null;
}

export interface MutationDeps {
  clock: Clock;
  idempotencyRepo: IdempotencyRepository;
  calendarId: string;
  resolveCalendarService: (userId?: string | null) => Promise<CalendarService | null>;
}

function noOp(kind: MutationOutcomeKind): MutationOutcome {
  return { kind, eventId: null, leaseAcquired: false, reusedCompletedResult: false, sanitizedErrorCode: null };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const record = err as Record<string, unknown>;
  if (typeof record.code === 'number') return record.code;
  const response = record.response as Record<string, unknown> | undefined;
  return typeof response?.status === 'number' ? (response.status as number) : undefined;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

interface MergedTiming {
  changed: boolean;
  start?: EventTimingField;
  end?: EventTimingField;
}

/**
 * bodyで指定されたtiming系フィールドのみをcurrent(直前のGET結果)へ重ね合わせる(read-modify-write)。
 * timed⇔all-dayの種別をまたぐ部分更新(例: 終日イベントにstartLocalだけ渡す)は不整合として拒否する。
 */
function mergeTiming(current: CalendarEventFullDetail, fields: UpdateEventRequestFields): MergedTiming | null {
  const currentIsAllDay = current.startDate !== null;
  const targetAllDay = fields.allDay ?? currentIsAllDay;
  const wantsTimedFields = fields.startLocal !== undefined || fields.endLocal !== undefined;
  const wantsAllDayFields = fields.startDate !== undefined || fields.endDateExclusive !== undefined;

  if (wantsTimedFields && targetAllDay) return null;
  if (wantsAllDayFields && !targetAllDay) return null;

  const noTimingChangeRequested = fields.allDay === undefined && !wantsTimedFields && !wantsAllDayFields;
  if (noTimingChangeRequested) {
    return { changed: false };
  }

  if (targetAllDay) {
    const startDate = fields.startDate ?? (currentIsAllDay ? current.startDate : null);
    const endDateExclusive = fields.endDateExclusive ?? (currentIsAllDay ? current.endDate : null);
    if (startDate === null || endDateExclusive === null || startDate >= endDateExclusive) return null;
    return { changed: true, start: { date: startDate }, end: { date: endDateExclusive } };
  }

  const startLocal = fields.startLocal ?? (!currentIsAllDay && current.startDateTime !== null ? toTokyoLocalFromIso(current.startDateTime) : null);
  const endLocal = fields.endLocal ?? (!currentIsAllDay && current.endDateTime !== null ? toTokyoLocalFromIso(current.endDateTime) : null);
  if (startLocal === null || endLocal === null) return null;

  const start = DateTime.fromISO(startLocal, { zone: TOKYO_ZONE });
  const end = DateTime.fromISO(endLocal, { zone: TOKYO_ZONE });
  if (!start.isValid || !end.isValid || end.toMillis() <= start.toMillis()) return null;

  return {
    changed: true,
    start: { dateTime: toRfc3339(start), timeZone: TOKYO_ZONE },
    end: { dateTime: toRfc3339(end), timeZone: TOKYO_ZONE },
  };
}

/**
 * idempotencyKey(呼び出し側が生成する運用キー、create時のcandidateId由来operationIdとは異なり
 * 決定的ハッシュではない)単位でCalendarへの二重patchを防ぎつつ、指定フィールドのみを
 * read-modify-writeで更新する。Calendar APIの呼び出しはFirestoreトランザクション外で行う。
 */
export async function updateCalendarEvent(
  deps: MutationDeps,
  params: { idempotencyKey: string; eventId: string; fields: UpdateEventRequestFields; userId?: string | null; abortSignal?: AbortSignal },
): Promise<MutationOutcome> {
  const now = deps.clock.now();
  const leaseOwner = randomUUID();

  const leaseResult = await deps.idempotencyRepo.acquireLeaseOrGetStatus({
    operationId: params.idempotencyKey,
    actionType: 'update_event',
    calendarId: deps.calendarId,
    leaseOwner,
    leaseDurationMs: LEASE_DURATION_MS,
    now,
    expiresAt: addDays(now, IDEMPOTENCY_RETENTION_DAYS),
  });

  if (leaseResult.kind === 'completed') {
    return {
      kind: 'success',
      eventId: leaseResult.doc.googleEventId,
      leaseAcquired: false,
      reusedCompletedResult: true,
      sanitizedErrorCode: null,
    };
  }
  if (leaseResult.kind === 'processing') {
    return noOp('already_processing');
  }

  // lease-acquired: Firestoreトランザクションの外でCalendar APIを呼ぶ
  const calendarService = await deps.resolveCalendarService(params.userId);
  if (!calendarService) {
    await deps.idempotencyRepo.markFailed({ operationId: params.idempotencyKey, sanitizedErrorCode: 'oauth_not_connected', now: deps.clock.now() });
    return { kind: 'oauth_not_connected', eventId: null, leaseAcquired: true, reusedCompletedResult: false, sanitizedErrorCode: 'oauth_not_connected' };
  }

  let current: CalendarEventFullDetail | null;
  try {
    current = await calendarService.getEventDetail(deps.calendarId, params.eventId, params.abortSignal);
  } catch (err) {
    const sanitizedCode = params.userId ? classifyProductCalendarError(err) : sanitizeError(err);
    await deps.idempotencyRepo.markFailed({ operationId: params.idempotencyKey, sanitizedErrorCode: sanitizedCode, now: deps.clock.now() });
    return {
      kind: isAbortError(err) ? 'timeout' : 'calendar_error',
      eventId: null,
      leaseAcquired: true,
      reusedCompletedResult: false,
      sanitizedErrorCode: sanitizedCode,
    };
  }
  if (!current) {
    await deps.idempotencyRepo.markFailed({ operationId: params.idempotencyKey, sanitizedErrorCode: 'not_found', now: deps.clock.now() });
    return { kind: 'not_found', eventId: null, leaseAcquired: true, reusedCompletedResult: false, sanitizedErrorCode: 'not_found' };
  }

  const merged = mergeTiming(current, params.fields);
  if (!merged) {
    await deps.idempotencyRepo.markFailed({ operationId: params.idempotencyKey, sanitizedErrorCode: 'invalid_range', now: deps.clock.now() });
    return { kind: 'invalid_range', eventId: null, leaseAcquired: true, reusedCompletedResult: false, sanitizedErrorCode: 'invalid_range' };
  }

  try {
    const result = await calendarService.patchEvent({
      calendarId: deps.calendarId,
      eventId: params.eventId,
      ifMatchEtag: current.etag ?? '',
      ...(params.fields.title !== undefined ? { summary: params.fields.title } : {}),
      ...(params.fields.description !== undefined ? { description: params.fields.description } : {}),
      ...(params.fields.location !== undefined ? { location: params.fields.location } : {}),
      ...(merged.changed ? { start: merged.start, end: merged.end } : {}),
      ...(params.abortSignal !== undefined ? { abortSignal: params.abortSignal } : {}),
    });

    await deps.idempotencyRepo.markCompleted({
      operationId: params.idempotencyKey,
      googleEventId: result.eventId,
      resultCode: 'updated',
      now: deps.clock.now(),
    });
    return { kind: 'success', eventId: result.eventId, leaseAcquired: true, reusedCompletedResult: false, sanitizedErrorCode: null };
  } catch (err) {
    const isConflict = extractHttpStatus(err) === 412;
    const sanitizedCode = params.userId ? classifyProductCalendarError(err) : sanitizeError(err);
    await deps.idempotencyRepo.markFailed({ operationId: params.idempotencyKey, sanitizedErrorCode: sanitizedCode, now: deps.clock.now() });
    return {
      kind: isAbortError(err) ? 'timeout' : isConflict ? 'conflict' : 'calendar_error',
      eventId: null,
      leaseAcquired: true,
      reusedCompletedResult: false,
      sanitizedErrorCode: sanitizedCode,
    };
  }
}

/**
 * 404/410(既に削除済み)はエラーではなく成功として扱う(他デバイスによる削除との整合、冪等性)。
 */
export async function deleteCalendarEvent(
  deps: MutationDeps,
  params: { idempotencyKey: string; eventId: string; userId?: string | null; abortSignal?: AbortSignal },
): Promise<MutationOutcome> {
  const now = deps.clock.now();
  const leaseOwner = randomUUID();

  const leaseResult = await deps.idempotencyRepo.acquireLeaseOrGetStatus({
    operationId: params.idempotencyKey,
    actionType: 'delete_event',
    calendarId: deps.calendarId,
    leaseOwner,
    leaseDurationMs: LEASE_DURATION_MS,
    now,
    expiresAt: addDays(now, IDEMPOTENCY_RETENTION_DAYS),
  });

  if (leaseResult.kind === 'completed') {
    return {
      kind: 'success',
      eventId: leaseResult.doc.googleEventId,
      leaseAcquired: false,
      reusedCompletedResult: true,
      sanitizedErrorCode: null,
    };
  }
  if (leaseResult.kind === 'processing') {
    return noOp('already_processing');
  }

  // lease-acquired: Firestoreトランザクションの外でCalendar APIを呼ぶ
  const calendarService = await deps.resolveCalendarService(params.userId);
  if (!calendarService) {
    await deps.idempotencyRepo.markFailed({ operationId: params.idempotencyKey, sanitizedErrorCode: 'oauth_not_connected', now: deps.clock.now() });
    return { kind: 'oauth_not_connected', eventId: null, leaseAcquired: true, reusedCompletedResult: false, sanitizedErrorCode: 'oauth_not_connected' };
  }

  try {
    await calendarService.deleteEvent(deps.calendarId, params.eventId, params.abortSignal);
    await deps.idempotencyRepo.markCompleted({
      operationId: params.idempotencyKey,
      googleEventId: params.eventId,
      resultCode: 'deleted',
      now: deps.clock.now(),
    });
    return { kind: 'success', eventId: params.eventId, leaseAcquired: true, reusedCompletedResult: false, sanitizedErrorCode: null };
  } catch (err) {
    if (isNotFoundError(err)) {
      await deps.idempotencyRepo.markCompleted({
        operationId: params.idempotencyKey,
        googleEventId: params.eventId,
        resultCode: 'already_deleted',
        now: deps.clock.now(),
      });
      return { kind: 'success', eventId: params.eventId, leaseAcquired: true, reusedCompletedResult: false, sanitizedErrorCode: null };
    }

    const sanitizedCode = params.userId ? classifyProductCalendarError(err) : sanitizeError(err);
    await deps.idempotencyRepo.markFailed({ operationId: params.idempotencyKey, sanitizedErrorCode: sanitizedCode, now: deps.clock.now() });
    return {
      kind: isAbortError(err) ? 'timeout' : 'calendar_error',
      eventId: null,
      leaseAcquired: true,
      reusedCompletedResult: false,
      sanitizedErrorCode: sanitizedCode,
    };
  }
}
