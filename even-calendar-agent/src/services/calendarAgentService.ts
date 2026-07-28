import type { DateTime } from 'luxon';
import { classifyCommand, type CommandType } from '../commands/commandClassifier.js';
import { buildFixedEventDefinition } from '../commands/fixedEventParser.js';
import { computeOperationId } from '../calendar/calendarEventId.js';
import { formatEventListForSpeech } from '../calendar/calendarFormatter.js';
import { todayRangeTokyo, tomorrowRangeTokyo } from '../time/tokyoDateTime.js';
import type { Clock } from '../time/clock.js';
import type { ConversationStateRepository } from '../firestore/conversationStateRepository.js';
import type { IdempotencyRepository } from '../firestore/idempotencyRepository.js';
import type { IdempotencyStatus } from '../firestore/models.js';
import type { CalendarService } from '../calendar/calendarService.js';
import { confirmAndCreateEvent, type ConfirmOutcomeKind } from './idempotentEventCreationService.js';
import type { DelayFn } from '../utils/delay.js';

const CONFIRMATION_EXPIRY_MS = 10 * 60 * 1000;
const CONVERSATION_STATE_VERSION = 1;

const UNSUPPORTED_MESSAGE = '現在は、今日の予定、明日の予定、明日の15時の接続テスト予定の登録に対応しています。';
const NOT_CONNECTED_MESSAGE = 'Googleカレンダーが未連携です。セットアップ画面で連携してください。';
const NO_PENDING_MESSAGE = '確認待ちの予定はありません。';
const EXPIRED_MESSAGE = '確認待ちの予定は期限切れです。もう一度予定を指定してください。';
const CANCELLED_MESSAGE = '登録をキャンセルしました。';
const REGISTERED_MESSAGE = 'Googleカレンダーに登録しました。';
const STILL_PROCESSING_MESSAGE = '登録処理中です。少し待ってから確認してください。';
const TEMPORARY_ERROR_MESSAGE = '一時的なエラーが発生しました。もう一度お試しください。';
const AUTH_ERROR_MESSAGE = 'Googleカレンダーとの連携が無効になっています。セットアップ画面で再連携してください。';
const CONFIRMATION_QUESTION = '明日の15時から16時まで、接続テスト予定を登録しますか？';

const CONFIRM_YES_REPLY_BY_KIND: Record<ConfirmOutcomeKind, string> = {
  'no-pending': NO_PENDING_MESSAGE,
  expired: EXPIRED_MESSAGE,
  'still-processing': STILL_PROCESSING_MESSAGE,
  success: REGISTERED_MESSAGE,
  'temporary-error': TEMPORARY_ERROR_MESSAGE,
  'auth-error': AUTH_ERROR_MESSAGE,
};

export interface CalendarAgentDeps {
  clock: Clock;
  userId: string;
  calendarId: string;
  conversationStateRepo: ConversationStateRepository;
  idempotencyRepo: IdempotencyRepository;
  resolveCalendarService: () => Promise<CalendarService | null>;
  delayFn?: DelayFn;
}

export interface CalendarAgentResult {
  replyText: string;
  commandType: CommandType;
  actionType: 'create_event' | null;
  oauthConnected: boolean | null;
  firestoreOperation: string | null;
  idempotencyStatus: IdempotencyStatus | null;
  calendarApiOperation: string | null;
  calendarApiResultCode: string | null;
  sanitizedErrorCode: string | null;
  leaseAcquired: boolean | null;
  reusedCompletedResult: boolean | null;
}

function baseResult(commandType: CommandType, replyText: string): CalendarAgentResult {
  return {
    replyText,
    commandType,
    actionType: null,
    oauthConnected: null,
    firestoreOperation: null,
    idempotencyStatus: null,
    calendarApiOperation: null,
    calendarApiResultCode: null,
    sanitizedErrorCode: null,
    leaseAcquired: null,
    reusedCompletedResult: null,
  };
}

export async function handleCalendarAgentCommand(
  deps: CalendarAgentDeps,
  content: unknown,
): Promise<CalendarAgentResult> {
  const commandType = classifyCommand(content);

  switch (commandType) {
    case 'today-list':
      return handleListCommand(deps, commandType, todayRangeTokyo(deps.clock), '今日の予定はありません。');
    case 'tomorrow-list':
      return handleListCommand(deps, commandType, tomorrowRangeTokyo(deps.clock), '明日の予定はありません。');
    case 'create-fixed-event':
      return handleCreateFixedEvent(deps, commandType);
    case 'confirm-yes':
      return handleConfirmYes(deps, commandType);
    case 'confirm-no':
      return handleConfirmNo(deps, commandType);
    default:
      return baseResult(commandType, UNSUPPORTED_MESSAGE);
  }
}

async function handleListCommand(
  deps: CalendarAgentDeps,
  commandType: CommandType,
  range: { start: DateTime; end: DateTime },
  emptyMessage: string,
): Promise<CalendarAgentResult> {
  const calendarService = await deps.resolveCalendarService();
  if (!calendarService) {
    const result = baseResult(commandType, NOT_CONNECTED_MESSAGE);
    result.oauthConnected = false;
    return result;
  }

  const events = await calendarService.listEventsForRange({
    calendarId: deps.calendarId,
    start: range.start,
    end: range.end,
  });
  const replyText = formatEventListForSpeech(events, emptyMessage);

  const result = baseResult(commandType, replyText);
  result.oauthConnected = true;
  result.calendarApiOperation = 'events.list';
  return result;
}

async function handleCreateFixedEvent(deps: CalendarAgentDeps, commandType: CommandType): Promise<CalendarAgentResult> {
  const calendarService = await deps.resolveCalendarService();
  if (!calendarService) {
    const result = baseResult(commandType, NOT_CONNECTED_MESSAGE);
    result.oauthConnected = false;
    return result;
  }

  const definition = buildFixedEventDefinition(deps.clock, deps.calendarId);
  const operationId = computeOperationId({
    userId: deps.userId,
    calendarId: definition.calendarId,
    summary: definition.summary,
    startDateTime: definition.startDateTime,
    endDateTime: definition.endDateTime,
    timeZone: definition.timeZone,
  });

  const now = deps.clock.now();
  await deps.conversationStateRepo.save({
    userId: deps.userId,
    state: 'awaiting_confirmation',
    actionType: 'create_event',
    operationId,
    calendarId: definition.calendarId,
    event: {
      summary: definition.summary,
      startDateTime: definition.startDateTime,
      endDateTime: definition.endDateTime,
      timeZone: definition.timeZone,
      description: definition.description,
    },
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + CONFIRMATION_EXPIRY_MS),
    version: CONVERSATION_STATE_VERSION,
  });

  const result = baseResult(commandType, CONFIRMATION_QUESTION);
  result.oauthConnected = true;
  result.actionType = 'create_event';
  result.firestoreOperation = 'conversationStates.save';
  return result;
}

async function handleConfirmYes(deps: CalendarAgentDeps, commandType: CommandType): Promise<CalendarAgentResult> {
  const calendarService = await deps.resolveCalendarService();
  if (!calendarService) {
    const result = baseResult(commandType, NOT_CONNECTED_MESSAGE);
    result.oauthConnected = false;
    return result;
  }

  const outcome = await confirmAndCreateEvent(
    {
      clock: deps.clock,
      conversationStateRepo: deps.conversationStateRepo,
      idempotencyRepo: deps.idempotencyRepo,
      calendarService,
      ...(deps.delayFn ? { delayFn: deps.delayFn } : {}),
    },
    deps.userId,
  );

  const result = baseResult(commandType, CONFIRM_YES_REPLY_BY_KIND[outcome.kind]);
  result.oauthConnected = true;
  result.actionType = 'create_event';
  result.firestoreOperation = 'idempotency.acquireLeaseOrGetStatus';
  result.idempotencyStatus = outcome.idempotencyStatus;
  result.calendarApiOperation = outcome.calendarApiOperation;
  result.calendarApiResultCode = outcome.calendarApiResultCode;
  result.sanitizedErrorCode = outcome.sanitizedErrorCode;
  result.leaseAcquired = outcome.leaseAcquired;
  result.reusedCompletedResult = outcome.reusedCompletedResult;
  return result;
}

async function handleConfirmNo(deps: CalendarAgentDeps, commandType: CommandType): Promise<CalendarAgentResult> {
  await deps.conversationStateRepo.clear(deps.userId);
  const result = baseResult(commandType, CANCELLED_MESSAGE);
  result.firestoreOperation = 'conversationStates.clear';
  return result;
}
