import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Clock } from '../time/clock.js';
import { TOKYO_ZONE, toRfc3339 } from '../time/tokyoDateTime.js';
import type { CalendarService } from '../calendar/calendarService.js';
import { computeOperationId, computeGoogleEventId } from '../calendar/calendarEventId.js';
import { sanitizeError } from '../security/sanitizedError.js';
import { classifyProductCalendarError } from '../product/productCalendarErrorClassifier.js';
import type { PluginEventCandidateRepository } from '../firestore/pluginEventCandidateRepository.js';
import type { SupportedLocale } from '../i18n/locale.js';

const LEASE_DURATION_MS = 30_000;
const CALENDAR_ID = 'primary';
/**
 * システム生成の来歴マーカー(ユーザー入力ではない)。POST bodyの `description` フィールドは
 * 存在しないため、ユーザー発話・ユーザー入力のdescriptionと連結・上書きされることはない。
 * 既に登録済みの予定のdescriptionは元の言語のまま永久に残る(仕様、遡及書き換えなし)。
 */
const EVENT_DESCRIPTION: Record<SupportedLocale, string> = {
  ja: 'Even G2から登録',
  en: 'Registered from Even G2',
};

export type RegisterCandidateOutcomeKind =
  | 'success'
  | 'candidate_invalid'
  | 'already_processing'
  | 'already_failed'
  | 'oauth_not_connected'
  | 'calendar_error';

/** googleEventId/予定内容などの生値は呼び出し元のログへ渡さないこと。 */
export interface RegisterCandidateOutcome {
  kind: RegisterCandidateOutcomeKind;
  leaseAcquired: boolean;
  reusedCompletedResult: boolean;
  calendarApiOperation: 'events.insert' | 'events.get' | null;
  sanitizedErrorCode: string | null;
}

export interface RegisterCandidateDeps {
  clock: Clock;
  candidateRepo: PluginEventCandidateRepository;
  resolveCalendarService: (userId?: string | null) => Promise<CalendarService | null>;
}

function noOp(kind: RegisterCandidateOutcomeKind): RegisterCandidateOutcome {
  return { kind, leaseAcquired: false, reusedCompletedResult: false, calendarApiOperation: null, sanitizedErrorCode: null };
}

/**
 * event_candidateをFirestoreトランザクションでpending→creatingへ遷移(lease取得)した上で、
 * 決定的なGoogle event ID(candidateIdベース)でCalendarへ冪等に登録する。
 * Calendar APIの呼び出しはFirestoreトランザクションの外側で行う。
 */
export async function registerCandidateEvent(
  deps: RegisterCandidateDeps,
  candidateId: string,
  userId?: string | null,
  locale: SupportedLocale = 'ja',
): Promise<RegisterCandidateOutcome> {
  const now = deps.clock.now();
  const leaseOwner = randomUUID();

  const leaseResult = await deps.candidateRepo.acquireLease({
    candidateId,
    leaseOwner,
    leaseDurationMs: LEASE_DURATION_MS,
    now,
  });

  if (leaseResult.kind === 'not_found' || leaseResult.kind === 'expired') {
    return noOp('candidate_invalid');
  }
  if (leaseResult.kind === 'lease_active') {
    return noOp('already_processing');
  }
  if (leaseResult.kind === 'already_completed') {
    return { kind: 'success', leaseAcquired: false, reusedCompletedResult: true, calendarApiOperation: null, sanitizedErrorCode: null };
  }
  if (leaseResult.kind === 'already_failed') {
    return {
      kind: 'already_failed',
      leaseAcquired: false,
      reusedCompletedResult: false,
      calendarApiOperation: null,
      sanitizedErrorCode: leaseResult.doc.sanitizedErrorCode,
    };
  }

  // lease_acquired: Firestoreトランザクションの外でCalendar APIを呼ぶ
  const doc = leaseResult.doc;
  const calendarService = await deps.resolveCalendarService(userId);

  if (!calendarService) {
    await deps.candidateRepo.markFailed(candidateId, 'oauth_not_connected', deps.clock.now());
    return {
      kind: 'oauth_not_connected',
      leaseAcquired: true,
      reusedCompletedResult: false,
      calendarApiOperation: null,
      sanitizedErrorCode: 'oauth_not_connected',
    };
  }

  // allDayで分岐: falseはstartLocal/endLocal(通常予定、既存どおり)、trueはstartDate/endDateExclusive
  // (終日予定、Google Calendar API方式の排他的終了日をそのまま使う。この層での±1日変換は行わない)。
  // operationIdのハッシュ入力はイベント内容の一意性を担保できればよいため、終日側もstartDate/
  // endDateExclusive文字列をそのままstartDateTime/endDateTime相当として渡す。
  let operationIdInput: { startDateTime: string; endDateTime: string; timeZone: string };

  if (doc.allDay) {
    const start = DateTime.fromISO(doc.startDate, { zone: TOKYO_ZONE });
    const end = DateTime.fromISO(doc.endDateExclusive, { zone: TOKYO_ZONE });
    if (!start.isValid || !end.isValid || end.toMillis() <= start.toMillis()) {
      await deps.candidateRepo.markFailed(candidateId, 'invalid_range', deps.clock.now());
      return {
        kind: 'candidate_invalid',
        leaseAcquired: true,
        reusedCompletedResult: false,
        calendarApiOperation: null,
        sanitizedErrorCode: 'invalid_range',
      };
    }
    operationIdInput = { startDateTime: doc.startDate, endDateTime: doc.endDateExclusive, timeZone: TOKYO_ZONE };
  } else {
    const startDateTime = toRfc3339(DateTime.fromISO(doc.startLocal, { zone: TOKYO_ZONE }));
    const endDateTime = toRfc3339(DateTime.fromISO(doc.endLocal, { zone: TOKYO_ZONE }));
    operationIdInput = { startDateTime, endDateTime, timeZone: TOKYO_ZONE };
  }

  const operationId = computeOperationId({
    userId: candidateId,
    calendarId: CALENDAR_ID,
    summary: doc.title,
    ...operationIdInput,
  });
  const eventId = computeGoogleEventId(operationId);

  try {
    const result = await calendarService.createEvent(
      doc.allDay
        ? {
            calendarId: CALENDAR_ID,
            eventId,
            summary: doc.title,
            allDay: true,
            startDate: doc.startDate,
            endDateExclusive: doc.endDateExclusive,
            description: EVENT_DESCRIPTION[locale],
            operationId,
          }
        : {
            calendarId: CALENDAR_ID,
            eventId,
            summary: doc.title,
            startDateTime: operationIdInput.startDateTime,
            endDateTime: operationIdInput.endDateTime,
            timeZone: TOKYO_ZONE,
            description: EVENT_DESCRIPTION[locale],
            operationId,
          },
    );

    await deps.candidateRepo.markCompleted(candidateId, result.eventId, deps.clock.now());
    return { kind: 'success', leaseAcquired: true, reusedCompletedResult: false, calendarApiOperation: 'events.insert', sanitizedErrorCode: null };
  } catch (err) {
    const sanitizedCode = sanitizeError(err);

    if (sanitizedCode === 'duplicate_id' || sanitizedCode === 'timeout') {
      const existing = await calendarService.getEvent(CALENDAR_ID, eventId);
      if (existing) {
        await deps.candidateRepo.markCompleted(candidateId, existing.eventId, deps.clock.now());
        return {
          kind: 'success',
          leaseAcquired: true,
          reusedCompletedResult: true,
          calendarApiOperation: 'events.get',
          sanitizedErrorCode: null,
        };
      }
    }

    // 制御フロー(重複/timeout時のidempotentなgetEventフォールバック)はsanitizeError()の分類のまま。
    // Firestore/ログへ残す最終コードのみ、product userの場合はより詳細な分類へ差し替える。
    const finalCode = userId ? classifyProductCalendarError(err) : sanitizedCode;
    await deps.candidateRepo.markFailed(candidateId, finalCode, deps.clock.now());
    return {
      kind: 'calendar_error',
      leaseAcquired: true,
      reusedCompletedResult: false,
      calendarApiOperation: 'events.insert',
      sanitizedErrorCode: finalCode,
    };
  }
}
