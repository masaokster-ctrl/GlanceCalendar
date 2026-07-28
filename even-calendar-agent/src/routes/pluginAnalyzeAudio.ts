import express, { Router, type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '../time/clock.js';
import { nowLocalIsoTokyo } from '../time/tokyoDateTime.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { logSanitizedError } from '../security/sanitizedError.js';
import { hashValue, shortHashPrefix } from '../security/devSessionToken.js';
import { validateWav, WAV_MAX_BYTES } from '../audio/wavValidator.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';
import type { PluginRateLimitRepository } from '../firestore/pluginRateLimitRepository.js';
import type { PluginRequestDedupeRepository } from '../firestore/pluginRequestDedupeRepository.js';
import type { PluginEventCandidateRepository } from '../firestore/pluginEventCandidateRepository.js';
import type { PluginConversationRepository } from '../firestore/pluginConversationRepository.js';
import { resolvePrincipal } from '../product/principal.js';
import type { ProductInstallationRepository } from '../product/productInstallationRepository.js';
import { MAX_TURNS } from '../firestore/pluginConversationRepository.js';
import type { GeminiClient } from '../gemini/geminiClient.js';
import { buildSystemInstruction } from '../gemini/systemInstruction.js';
import { parseInitialFragmentResult, type EventCandidateResult, type ResultType } from '../gemini/eventCandidateSchema.js';
import { resolveCandidate, BLANK_FRAGMENTS } from '../gemini/candidateFragments.js';
import type { PluginEventCandidateTiming } from '../firestore/models.js';

const REQUIRED_SCOPE = 'audio:analyze';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_GEMINI_TIMEOUT_MS = 25_000;
const DEFAULT_REQUEST_DEDUPE_TTL_MS = 10 * 60 * 1000;
const CANDIDATE_TTL_MS = 10 * 60 * 1000;
const CONVERSATION_TTL_MS = 10 * 60 * 1000;

export interface PluginAnalyzeAudioRouterDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
  rateLimitRepo: PluginRateLimitRepository;
  requestDedupeRepo: PluginRequestDedupeRepository;
  candidateRepo: PluginEventCandidateRepository;
  conversationRepo: PluginConversationRepository;
  geminiClient: GeminiClient;
  geminiModel: string;
  vertexLocation: string;
  /** device session(Phase 2H)のtokenVersion/installation失効確認に使う。dev専用利用時は省略可。 */
  productInstallationRepo?: ProductInstallationRepository;
  geminiTimeoutMs?: number;
  rateLimitPerMinute?: number;
  requestDedupeTtlMs?: number;
  candidateTtlMs?: number;
  conversationTtlMs?: number;
}

function errorJson(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error' } });
}

function computeRequestKeyHash(sessionTokenHash: string, installId: string, requestId: string): string {
  return createHash('sha256').update(`${sessionTokenHash}:${installId}:${requestId}`, 'utf8').digest('hex');
}

export function createPluginAnalyzeAudioRouter(deps: PluginAnalyzeAudioRouterDeps): Router {
  const router = Router();
  const rateLimitPerMinute = deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const geminiTimeoutMs = deps.geminiTimeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
  const requestDedupeTtlMs = deps.requestDedupeTtlMs ?? DEFAULT_REQUEST_DEDUPE_TTL_MS;
  const candidateTtlMs = deps.candidateTtlMs ?? CANDIDATE_TTL_MS;
  const conversationTtlMs = deps.conversationTtlMs ?? CONVERSATION_TTL_MS;

  // /plugin/analyze-audio と OPTIONS だけに限定したCORS許可。他のroute(/v1/chat/completions、
  // /oauth2/*、/setup/*、/plugin/dev-sessions*)には一切適用しない。
  router.use('/plugin/analyze-audio', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Install-Id, X-Request-Id');
    next();
  });

  router.options('/plugin/analyze-audio', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.post(
    '/plugin/analyze-audio',
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

      const now = deps.clock.now();
      const rateLimitResult = await deps.rateLimitRepo.consume({
        sessionKey: tokenHash,
        now,
        limit: rateLimitPerMinute,
      });
      logSafeEvent({
        event: 'plugin_analyze_audio_rate_limit_checked',
        sessionHashPrefix: shortHashPrefix(tokenHash),
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
          event: 'plugin_analyze_audio_duplicate_request',
          requestIdHashPrefix: shortHashPrefix(createHash('sha256').update(requestId, 'utf8').digest('hex')),
          duplicateRequest: true,
        });
        errorJson(res, 409, 'Duplicate request');
        return;
      }

      const wavCheck = validateWav(audioBuffer);
      if (!wavCheck.ok) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        const status = wavCheck.reason === 'too_large' ? 413 : 400;
        errorJson(res, status, 'Invalid audio');
        return;
      }

      const nowLocal = nowLocalIsoTokyo(deps.clock);
      const systemInstruction = buildSystemInstruction(nowLocal);
      const audioBase64 = audioBuffer.toString('base64');
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), geminiTimeoutMs);

      let rawJson: string | undefined;
      try {
        rawJson = await deps.geminiClient.generateEventCandidateJson({
          audioBase64,
          systemInstruction,
          abortSignal: abortController.signal,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        const isAbort = err instanceof Error && err.name === 'AbortError';
        logSanitizedError('plugin_analyze_audio_gemini_call_failed', err, {
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

      const parsed = parsedRaw !== undefined ? parseInitialFragmentResult(parsedRaw) : null;
      if (!parsed) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        logSafeEvent({
          event: 'plugin_analyze_audio_schema_invalid',
          geminiModel: deps.geminiModel,
          vertexLocation: deps.vertexLocation,
        });
        errorJson(res, 502, 'Model failure');
        return;
      }

      // 初回発話には既存fragmentsがまだ無いため空状態からmergeする。resultTypeは
      // parseInitialFragmentResultの時点で'cancelled'を許可していないため'as ResultType'は安全。
      const resolved = resolveCandidate(BLANK_FRAGMENTS, parsed, nowLocal);
      const result: EventCandidateResult = {
        schemaVersion: '1',
        resultType: resolved.resultType as ResultType,
        title: resolved.title,
        startLocal: resolved.startLocal,
        endLocal: resolved.endLocal,
        timeZone: resolved.timeZone,
        allDay: resolved.allDay,
        clarificationField: resolved.clarificationField,
        clarificationQuestion: resolved.clarificationQuestion,
        assumptions: resolved.assumptions,
        // startDate/endDateExclusiveは終日候補完成時のみキーを含める(EventCandidateResultの規約)。
        ...(resolved.startDate !== null ? { startDate: resolved.startDate, endDateExclusive: resolved.endDateExclusive as string } : {}),
      };

      await deps.requestDedupeRepo.markStatus(requestKeyHash, 'completed', deps.clock.now());

      let candidateId: string | null = null;
      let conversationId: string | null = null;
      let turn: number | null = null;

      if (
        result.resultType === 'event_candidate' &&
        ((result.startLocal && result.endLocal) || (result.startDate && result.endDateExclusive))
      ) {
        candidateId = randomUUID();
        const createdAt = deps.clock.now();
        // allDayの値に応じてstartLocal/endLocalかstartDate/endDateExclusiveのどちらかを渡す
        // (PluginEventCandidateTimingの判別可能ユニオンに合わせる。リテラルtrue/falseで分岐する)。
        const timing: PluginEventCandidateTiming = result.allDay
          ? {
              allDay: true,
              startLocal: null,
              endLocal: null,
              startDate: result.startDate as string,
              endDateExclusive: result.endDateExclusive as string,
            }
          : {
              allDay: false,
              startLocal: result.startLocal as string,
              endLocal: result.endLocal as string,
              startDate: null,
              endDateExclusive: null,
            };
        await deps.candidateRepo.create({
          candidateId,
          sessionHash: tokenHash,
          installIdHash: hashValue(installId),
          title: result.title ?? '',
          timeZone: result.timeZone,
          now: createdAt,
          expiresAt: new Date(createdAt.getTime() + candidateTtlMs),
          analysisRequestIdHash: createHash('sha256').update(requestId, 'utf8').digest('hex'),
          ...timing,
        });
      } else if (result.resultType === 'needs_clarification' && result.clarificationField) {
        const createdAt = deps.clock.now();
        // 同一セッションの既存active会話(あれば)を破棄してから新規開始する。
        await deps.conversationRepo.cancelActiveForSession(tokenHash, createdAt);
        conversationId = randomUUID();
        await deps.conversationRepo.create({
          conversationId,
          sessionHash: tokenHash,
          installIdHash: hashValue(installId),
          partialCandidate: {
            title: resolved.mergedFragments.title,
            dateLocal: resolved.mergedFragments.dateLocal,
            startTimeLocal: resolved.mergedFragments.startTimeLocal,
            durationMinutes: resolved.mergedFragments.durationMinutes,
            endDateLocal: resolved.mergedFragments.endDateLocal,
            allDaySignal: resolved.mergedFragments.allDaySignal,
            startLocal: null,
            endLocal: null,
            timeZone: result.timeZone,
            allDay: result.allDay,
          },
          missingField: result.clarificationField,
          now: createdAt,
          expiresAt: new Date(createdAt.getTime() + conversationTtlMs),
        });
        turn = 1;
      }

      logSafeEvent({
        event: 'plugin_analyze_audio_succeeded',
        sessionHashPrefix: shortHashPrefix(tokenHash),
        receivedBytes: audioBuffer.byteLength,
        estimatedDurationMs: wavCheck.estimatedDurationMs,
        resultType: result.resultType,
        geminiModel: deps.geminiModel,
        vertexLocation: deps.vertexLocation,
        latencyMs: Date.now() - startedAt,
        httpStatus: 200,
      });

      res.status(200).json({
        requestId,
        result,
        candidateId,
        conversationId,
        turn,
        maxTurns: conversationId !== null ? MAX_TURNS : null,
      });
    },
  );

  return router;
}
