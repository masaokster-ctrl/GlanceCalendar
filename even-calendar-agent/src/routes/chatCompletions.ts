import { Router, type RequestHandler, type Response } from 'express';
import { requestMetadataLogger } from '../middleware/requestMetadataLogger.js';
import { buildChatCompletionChunks, buildChatCompletionResponse } from '../services/openAiCompatibleResponse.js';
import type { ChatCompletionRequestBody } from '../types/chat.js';
import { detectTestMode, TEST_MODE_CONTENT, TEST_MODE_DELAY_MS } from '../utils/testModeDetector.js';
import { getLastUserMessageContent } from '../utils/lastUserMessage.js';
import { computeRequestFingerprint } from '../utils/requestFingerprint.js';
import { extractTraceId } from '../utils/traceId.js';
import { delay as defaultDelay, type DelayFn } from '../utils/delay.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { instanceId } from '../security/instanceId.js';
import { systemClock, type Clock } from '../time/clock.js';
import { computeDeliveryKey } from '../firestore/deliveryKey.js';
import {
  InMemoryConversationStateRepository,
  type ConversationStateRepository,
} from '../firestore/conversationStateRepository.js';
import { InMemoryIdempotencyRepository, type IdempotencyRepository } from '../firestore/idempotencyRepository.js';
import {
  InMemoryDeliveryDedupeRepository,
  type DeliveryDedupeRepository,
} from '../firestore/deliveryDedupeRepository.js';
import type { CalendarService } from '../calendar/calendarService.js';
import { handleCalendarAgentCommand, type CalendarAgentResult } from '../services/calendarAgentService.js';

const DEFAULT_USER_ID = 'single-user';
const DEFAULT_CALENDAR_ID = 'primary';
const DELIVERY_DEDUPE_TTL_MS = 10 * 60 * 1000;

export interface ChatCompletionsRouterOptions {
  delayFn?: DelayFn;
  enableProbeTests?: boolean;
  clock?: Clock;
  userId?: string;
  calendarId?: string;
  conversationStateRepo?: ConversationStateRepository;
  idempotencyRepo?: IdempotencyRepository;
  deliveryDedupeRepo?: DeliveryDedupeRepository;
  resolveCalendarService?: () => Promise<CalendarService | null>;
}

function writeSseChunk(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function defaultResolveCalendarService(): Promise<CalendarService | null> {
  return null;
}

export function createChatCompletionsRouter(
  authMiddleware: RequestHandler,
  options: ChatCompletionsRouterOptions = {},
): Router {
  const delayFn = options.delayFn ?? defaultDelay;
  const enableProbeTests = options.enableProbeTests ?? false;
  const clock = options.clock ?? systemClock;
  const userId = options.userId ?? DEFAULT_USER_ID;
  const calendarId = options.calendarId ?? DEFAULT_CALENDAR_ID;
  const conversationStateRepo = options.conversationStateRepo ?? new InMemoryConversationStateRepository();
  const idempotencyRepo = options.idempotencyRepo ?? new InMemoryIdempotencyRepository();
  const deliveryDedupeRepo = options.deliveryDedupeRepo ?? new InMemoryDeliveryDedupeRepository();
  const resolveCalendarService = options.resolveCalendarService ?? defaultResolveCalendarService;

  const router = Router();

  router.post('/v1/chat/completions', authMiddleware, requestMetadataLogger, (req, res) => {
    const receivedAt = Date.now();
    const body = req.body as ChatCompletionRequestBody | undefined;
    const isStream = body?.stream === true;

    const messages = body?.messages;
    const messageCount = Array.isArray(messages) ? messages.length : null;
    const lastUserContent = getLastUserMessageContent(messages);

    const fingerprint = computeRequestFingerprint({
      model: body?.model,
      messageCount,
      lastUserContent,
    });
    const traceId = extractTraceId(req.header('x-cloud-trace-context'));

    const controller = new AbortController();
    let clientDisconnected = false;

    // res(応答)側の close で判定する。req側の close はボディ受信完了だけでも発火するため使わない。
    const onClose = (): void => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        controller.abort();
      }
    };
    res.on('close', onClose);

    const cleanup = (): void => {
      res.off('close', onClose);
    };

    void (async (): Promise<void> => {
      const probeTestMode = enableProbeTests ? detectTestMode(lastUserContent) : 'default';

      const now = clock.now();
      const deliveryKey = computeDeliveryKey(fingerprint, now);
      const duplicateDetected = await deliveryDedupeRepo.recordAndCheckDuplicate({
        deliveryKey,
        requestFingerprint: fingerprint,
        operationId: null,
        actionType: null,
        now,
        expiresAt: new Date(now.getTime() + DELIVERY_DEDUPE_TTL_MS),
      });

      let content: string;
      let configuredDelayMs: number;
      let agentResult: CalendarAgentResult | null = null;

      if (probeTestMode !== 'default') {
        content = TEST_MODE_CONTENT[probeTestMode];
        configuredDelayMs = TEST_MODE_DELAY_MS[probeTestMode];
      } else {
        agentResult = await handleCalendarAgentCommand(
          {
            clock,
            userId,
            calendarId,
            conversationStateRepo,
            idempotencyRepo,
            resolveCalendarService,
            ...(options.delayFn ? { delayFn: options.delayFn } : {}),
          },
          lastUserContent,
        );
        content = agentResult.replyText;
        configuredDelayMs = 0;
      }

      try {
        await delayFn(configuredDelayMs, controller.signal);
      } catch {
        logSafeEvent({
          event: 'chat_completions_client_disconnected',
          requestFingerprint: fingerprint,
          clientDisconnected: true,
          configuredDelayMs,
          elapsedMs: Date.now() - receivedAt,
          instanceId,
        });
        cleanup();
        return;
      }

      if (clientDisconnected || res.writableEnded) {
        cleanup();
        return;
      }

      let responseType: 'json' | 'sse';

      if (!isStream) {
        responseType = 'json';
        res.status(200).json(buildChatCompletionResponse(content));
      } else {
        responseType = 'sse';
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        for (const chunk of buildChatCompletionChunks(content)) {
          writeSseChunk(res, chunk);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }

      logSafeEvent({
        event: 'chat_completions_response_sent',
        requestFingerprint: fingerprint,
        durationMs: Date.now() - receivedAt,
        traceId,
        httpStatus: res.statusCode,
        responseType,
        duplicateDetected,
        instanceId,
        ...(probeTestMode !== 'default' ? { testMode: probeTestMode } : {}),
        ...(agentResult
          ? {
              commandType: agentResult.commandType,
              ...(agentResult.actionType !== null ? { actionType: agentResult.actionType } : {}),
              ...(agentResult.oauthConnected !== null ? { oauthConnected: agentResult.oauthConnected } : {}),
              ...(agentResult.firestoreOperation !== null ? { firestoreOperation: agentResult.firestoreOperation } : {}),
              ...(agentResult.idempotencyStatus !== null ? { idempotencyStatus: agentResult.idempotencyStatus } : {}),
              ...(agentResult.calendarApiOperation !== null
                ? { calendarApiOperation: agentResult.calendarApiOperation }
                : {}),
              ...(agentResult.calendarApiResultCode !== null
                ? { calendarApiResultCode: agentResult.calendarApiResultCode }
                : {}),
              ...(agentResult.sanitizedErrorCode !== null ? { sanitizedErrorCode: agentResult.sanitizedErrorCode } : {}),
              ...(agentResult.leaseAcquired !== null ? { leaseAcquired: agentResult.leaseAcquired } : {}),
              ...(agentResult.reusedCompletedResult !== null
                ? { reusedCompletedResult: agentResult.reusedCompletedResult }
                : {}),
            }
          : {}),
      });

      cleanup();
    })();
  });

  return router;
}
