import express, { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import type { Clock } from '../time/clock.js';
import { nowLocalIsoTokyo } from '../time/tokyoDateTime.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { sanitizeError, logSanitizedError } from '../security/sanitizedError.js';
import { hashValue, shortHashPrefix } from '../security/devSessionToken.js';
import { validateWav, WAV_MAX_BYTES } from '../audio/wavValidator.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';
import type { PluginRateLimitRepository } from '../firestore/pluginRateLimitRepository.js';
import type { PluginRequestDedupeRepository } from '../firestore/pluginRequestDedupeRepository.js';
import type { CalendarService } from '../calendar/calendarService.js';
import type { CalendarEventFullDetail } from '../calendar/calendarClient.js';
import { toEventDetailResponseItem } from '../calendar/eventResponseMapping.js';
import { resolvePrincipal } from '../product/principal.js';
import type { ProductInstallationRepository } from '../product/productInstallationRepository.js';
import { classifyProductCalendarError } from '../product/productCalendarErrorClassifier.js';
import type { GeminiClient } from '../gemini/geminiClient.js';
import { buildEditSystemInstruction } from '../gemini/editSystemInstruction.js';
import { parseEditInstructionGeminiOutput, resolveEditInstruction, type CurrentEventContext } from '../gemini/editInstructionSchema.js';

const REQUIRED_SCOPE = 'audio:analyze';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** pluginCalendarEventsItem.tsと同じ許容範囲(定期予定インスタンスID等も含む)。 */
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{5,1024}$/;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_GEMINI_TIMEOUT_MS = 25_000;
const DEFAULT_REQUEST_DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CALENDAR_TIMEOUT_MS = 10_000;

export interface PluginAnalyzeEditAudioRouterDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
  rateLimitRepo: PluginRateLimitRepository;
  requestDedupeRepo: PluginRequestDedupeRepository;
  calendarId: string;
  resolveCalendarService: (userId?: string | null) => Promise<CalendarService | null>;
  geminiClient: GeminiClient;
  geminiModel: string;
  vertexLocation: string;
  /** device session(Phase 2H)のtokenVersion/installation失効確認に使う。dev専用利用時は省略可。 */
  productInstallationRepo?: ProductInstallationRepository;
  geminiTimeoutMs?: number;
  rateLimitPerMinute?: number;
  requestDedupeTtlMs?: number;
  calendarTimeoutMs?: number;
}

function errorJson(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error' } });
}

function computeRequestKeyHash(sessionTokenHash: string, installId: string, requestId: string): string {
  return createHash('sha256').update(`${sessionTokenHash}:${installId}:${requestId}`, 'utf8').digest('hex');
}

/** CalendarEventFullDetailの整形結果(toEventDetailResponseItem)からGemini/差分計算用のCurrentEventContextへ変換する。 */
function toCurrentEventContext(current: ReturnType<typeof toEventDetailResponseItem>): CurrentEventContext {
  return {
    title: current.title,
    allDay: current.allDay,
    ...(current.startLocal !== undefined ? { startLocal: current.startLocal } : {}),
    ...(current.endLocal !== undefined ? { endLocal: current.endLocal } : {}),
    ...(current.startDate !== undefined ? { startDate: current.startDate } : {}),
    ...(current.endDateExclusive !== undefined ? { endDateExclusive: current.endDateExclusive } : {}),
    ...(current.location !== undefined ? { location: current.location } : {}),
    ...(current.description !== undefined ? { description: current.description } : {}),
  };
}

export function createPluginAnalyzeEditAudioRouter(deps: PluginAnalyzeEditAudioRouterDeps): Router {
  const router = Router();
  const rateLimitPerMinute = deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const geminiTimeoutMs = deps.geminiTimeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
  const requestDedupeTtlMs = deps.requestDedupeTtlMs ?? DEFAULT_REQUEST_DEDUPE_TTL_MS;
  const calendarTimeoutMs = deps.calendarTimeoutMs ?? DEFAULT_CALENDAR_TIMEOUT_MS;

  // /plugin/analyze-edit-audio と OPTIONS だけに限定したCORS許可。他のrouteには一切適用しない。
  router.use('/plugin/analyze-edit-audio', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Install-Id, X-Request-Id, X-Event-Id');
    next();
  });

  router.options('/plugin/analyze-edit-audio', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.post(
    '/plugin/analyze-edit-audio',
    express.raw({ type: 'audio/wav', limit: WAV_MAX_BYTES }),
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const contentType = req.headers['content-type'];
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('audio/wav')) {
        errorJson(res, 415, 'Unsupported Media Type');
        return;
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        errorJson(res, 400, 'Bad Request');
        return;
      }
      const audioBuffer = req.body;

      const auth = await resolvePrincipal(
        req,
        {
          clock: deps.clock,
          pluginSessionRepo: deps.pluginSessionRepo,
          ...(deps.productInstallationRepo ? { productInstallationRepo: deps.productInstallationRepo } : {}),
        },
        REQUIRED_SCOPE,
      );
      if (!auth.ok) {
        errorJson(res, auth.status, auth.status === 401 ? 'Unauthorized' : auth.status === 403 ? 'Forbidden' : 'Bad Request');
        return;
      }
      const tokenHash = auth.principal.tokenHash;
      const installId = auth.principal.installId;

      const requestId = req.header('x-request-id');
      if (!requestId || !UUID_PATTERN.test(requestId)) {
        errorJson(res, 400, 'X-Request-Id header is required');
        return;
      }

      const eventId = req.header('x-event-id') ?? '';
      if (!EVENT_ID_PATTERN.test(eventId)) {
        errorJson(res, 400, 'X-Event-Id header is required');
        return;
      }
      const eventIdHashPrefix = shortHashPrefix(hashValue(eventId));

      const now = deps.clock.now();
      const rateLimitResult = await deps.rateLimitRepo.consume({
        sessionKey: `${tokenHash}:analyze-edit-audio`,
        now,
        limit: rateLimitPerMinute,
      });
      logSafeEvent({
        event: 'plugin_analyze_edit_audio_rate_limit_checked',
        sessionHashPrefix: shortHashPrefix(tokenHash),
        eventIdHashPrefix,
        rateLimitAllowed: rateLimitResult.allowed,
      });
      if (!rateLimitResult.allowed) {
        res.setHeader('Retry-After', String(rateLimitResult.retryAfterSeconds));
        errorJson(res, 429, 'Too Many Requests');
        return;
      }

      const requestKeyHash = computeRequestKeyHash(tokenHash, installId, requestId);
      const dedupeResult = await deps.requestDedupeRepo.acquire({
        requestKeyHash,
        now,
        expiresAt: new Date(now.getTime() + requestDedupeTtlMs),
      });
      if (dedupeResult.kind === 'duplicate') {
        logSafeEvent({
          event: 'plugin_analyze_edit_audio_duplicate_request',
          requestIdHashPrefix: shortHashPrefix(createHash('sha256').update(requestId, 'utf8').digest('hex')),
          duplicateRequest: true,
        });
        errorJson(res, 409, 'Duplicate request');
        return;
      }

      // 現在値をGeminiの文脈・no-op検出の両方に使うため、音声解析より先に読み取り専用で取得する。
      const calendarService = await deps.resolveCalendarService(auth.principal.userId);
      if (!calendarService) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        logSafeEvent({
          event: 'plugin_analyze_edit_audio_calendar_not_connected',
          sessionHashPrefix: shortHashPrefix(tokenHash),
          eventIdHashPrefix,
          sanitizedErrorCode: 'reauthentication_required',
        });
        errorJson(res, 403, 'Forbidden');
        return;
      }

      const calendarAbortController = new AbortController();
      const calendarTimeoutHandle = setTimeout(() => calendarAbortController.abort(), calendarTimeoutMs);

      let detail: CalendarEventFullDetail | null;
      try {
        detail = await calendarService.getEventDetail(deps.calendarId, eventId, calendarAbortController.signal);
      } catch (err) {
        clearTimeout(calendarTimeoutHandle);
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const sanitizedErrorCode = auth.principal.userId ? classifyProductCalendarError(err) : sanitizeError(err);
        logSafeEvent({
          event: 'plugin_analyze_edit_audio_calendar_call_failed',
          level: 'error',
          sessionHashPrefix: shortHashPrefix(tokenHash),
          eventIdHashPrefix,
          sanitizedErrorCode,
        });
        errorJson(res, isAbort ? 504 : 502, isAbort ? 'Calendar API timeout' : 'Calendar API failure');
        return;
      }
      clearTimeout(calendarTimeoutHandle);

      if (!detail) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        logSafeEvent({
          event: 'plugin_analyze_edit_audio_event_not_found',
          sessionHashPrefix: shortHashPrefix(tokenHash),
          eventIdHashPrefix,
        });
        errorJson(res, 404, 'Event not found');
        return;
      }

      const currentContext = toCurrentEventContext(toEventDetailResponseItem(detail));

      const wavCheck = validateWav(audioBuffer);
      if (!wavCheck.ok) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        logSafeEvent({
          event: 'plugin_analyze_edit_audio_invalid_wav',
          sessionHashPrefix: shortHashPrefix(tokenHash),
          eventIdHashPrefix,
          sanitizedErrorCode: 'audio_too_short',
        });
        const status = wavCheck.reason === 'too_large' ? 413 : 400;
        errorJson(res, status, 'Invalid audio');
        return;
      }

      const nowLocal = nowLocalIsoTokyo(deps.clock);
      const systemInstruction = buildEditSystemInstruction(nowLocal, currentContext);
      const audioBase64 = audioBuffer.toString('base64');
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), geminiTimeoutMs);

      let rawJson: string | undefined;
      try {
        rawJson = await deps.geminiClient.generateEditInstructionJson({
          audioBase64,
          systemInstruction,
          abortSignal: abortController.signal,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        const isAbort = err instanceof Error && err.name === 'AbortError';
        logSanitizedError('plugin_analyze_edit_audio_gemini_call_failed', err, {
          geminiModel: deps.geminiModel,
          vertexLocation: deps.vertexLocation,
        });
        errorJson(res, isAbort ? 504 : 502, isAbort ? 'Model timeout' : 'Model failure');
        return;
      }
      clearTimeout(timeoutHandle);

      let parsedRaw: unknown;
      try {
        parsedRaw = rawJson !== undefined ? JSON.parse(rawJson) : undefined;
      } catch {
        parsedRaw = undefined;
      }

      const parsed = parsedRaw !== undefined ? parseEditInstructionGeminiOutput(parsedRaw) : null;
      if (!parsed) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        logSafeEvent({
          event: 'plugin_analyze_edit_audio_schema_invalid',
          geminiModel: deps.geminiModel,
          vertexLocation: deps.vertexLocation,
        });
        errorJson(res, 502, 'Model failure');
        return;
      }

      const resolved = resolveEditInstruction(currentContext, parsed);

      await deps.requestDedupeRepo.markStatus(requestKeyHash, 'completed', deps.clock.now());

      logSafeEvent({
        event: 'plugin_analyze_edit_audio_succeeded',
        sessionHashPrefix: shortHashPrefix(tokenHash),
        eventIdHashPrefix,
        receivedBytes: audioBuffer.byteLength,
        estimatedDurationMs: wavCheck.estimatedDurationMs,
        resultType: resolved.kind,
        ...(resolved.kind === 'not_understood' ? { sanitizedErrorCode: resolved.reason } : {}),
        geminiModel: deps.geminiModel,
        vertexLocation: deps.vertexLocation,
        latencyMs: Date.now() - startedAt,
        httpStatus: 200,
      });

      if (resolved.kind === 'not_understood') {
        res.status(200).json({ requestId, result: { schemaVersion: '1', resultType: 'not_understood' } });
        return;
      }

      res.status(200).json({
        requestId,
        result: { schemaVersion: '1', resultType: 'edit', fields: resolved.fields },
      });
    },
  );

  return router;
}
