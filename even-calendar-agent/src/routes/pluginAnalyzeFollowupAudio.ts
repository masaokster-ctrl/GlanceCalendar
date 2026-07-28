import express, { Router, type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '../time/clock.js';
import { nowLocalIsoTokyo } from '../time/tokyoDateTime.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { logSanitizedError } from '../security/sanitizedError.js';
import { hashValue, shortHashPrefix } from '../security/devSessionToken.js';
import { validateWav, WAV_MAX_BYTES } from '../audio/wavValidator.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';
import type { PluginRequestDedupeRepository } from '../firestore/pluginRequestDedupeRepository.js';
import type { PluginEventCandidateRepository } from '../firestore/pluginEventCandidateRepository.js';
import { MAX_TURNS, type PluginConversationRepository } from '../firestore/pluginConversationRepository.js';
import { resolvePrincipal } from '../product/principal.js';
import type { ProductInstallationRepository } from '../product/productInstallationRepository.js';
import type { GeminiClient } from '../gemini/geminiClient.js';
import { buildFollowupSystemInstruction } from '../gemini/followupSystemInstruction.js';
import { parseFollowupFragmentResult, type FollowupResult } from '../gemini/followupResultSchema.js';
import { resolveCandidate, type CandidateFragments } from '../gemini/candidateFragments.js';
import type { PluginEventCandidateTiming } from '../firestore/models.js';

const REQUIRED_SCOPE = 'audio:analyze';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_GEMINI_TIMEOUT_MS = 25_000;
const DEFAULT_REQUEST_DEDUPE_TTL_MS = 10 * 60 * 1000;
const CANDIDATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LEASE_DURATION_MS = 30_000;

export interface PluginAnalyzeFollowupAudioRouterDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
  conversationRepo: PluginConversationRepository;
  requestDedupeRepo: PluginRequestDedupeRepository;
  candidateRepo: PluginEventCandidateRepository;
  geminiClient: GeminiClient;
  geminiModel: string;
  vertexLocation: string;
  /** device session(Phase 2H)のtokenVersion/installation失効確認に使う。dev専用利用時は省略可。 */
  productInstallationRepo?: ProductInstallationRepository;
  geminiTimeoutMs?: number;
  requestDedupeTtlMs?: number;
  candidateTtlMs?: number;
  followupLeaseDurationMs?: number;
}

function errorJson(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error' } });
}

function computeRequestKeyHash(sessionTokenHash: string, installId: string, conversationId: string, requestId: string): string {
  return createHash('sha256').update(`${sessionTokenHash}:${installId}:${conversationId}:${requestId}`, 'utf8').digest('hex');
}

export function createPluginAnalyzeFollowupAudioRouter(deps: PluginAnalyzeFollowupAudioRouterDeps): Router {
  const router = Router();
  const geminiTimeoutMs = deps.geminiTimeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
  const requestDedupeTtlMs = deps.requestDedupeTtlMs ?? DEFAULT_REQUEST_DEDUPE_TTL_MS;
  const candidateTtlMs = deps.candidateTtlMs ?? CANDIDATE_TTL_MS;
  const followupLeaseDurationMs = deps.followupLeaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;

  router.use('/plugin/analyze-followup-audio', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Install-Id, X-Request-Id, X-Conversation-Id');
    next();
  });

  router.options('/plugin/analyze-followup-audio', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.post(
    '/plugin/analyze-followup-audio',
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
      const conversationId = req.header('x-conversation-id');
      if (!requestId || !UUID_PATTERN.test(requestId) || !conversationId || !UUID_PATTERN.test(conversationId)) {
        errorJson(res, 400, 'X-Request-Id and X-Conversation-Id headers are required');
        return;
      }

      const now = deps.clock.now();
      const requestKeyHash = computeRequestKeyHash(tokenHash, installId, conversationId, requestId);
      const dedupeResult = await deps.requestDedupeRepo.acquire({
        requestKeyHash,
        now,
        expiresAt: new Date(now.getTime() + requestDedupeTtlMs),
      });
      if (dedupeResult.kind === 'duplicate') {
        logSafeEvent({
          event: 'plugin_analyze_followup_audio_duplicate_request',
          requestIdHashPrefix: shortHashPrefix(createHash('sha256').update(requestId, 'utf8').digest('hex')),
          duplicateRequest: true,
        });
        errorJson(res, 409, 'Duplicate request');
        return;
      }

      const conversation = await deps.conversationRepo.get(conversationId);
      if (!conversation) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        errorJson(res, 410, 'Conversation is no longer valid');
        return;
      }
      if (conversation.sessionHash !== tokenHash || conversation.installIdHash !== hashValue(installId)) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        errorJson(res, 403, 'Forbidden');
        return;
      }

      const leaseOwner = randomUUID();
      const leaseResult = await deps.conversationRepo.acquireFollowupLease({
        conversationId,
        leaseOwner,
        leaseDurationMs: followupLeaseDurationMs,
        now,
      });

      if (
        leaseResult.kind === 'not_found' ||
        leaseResult.kind === 'expired' ||
        leaseResult.kind === 'wrong_status' ||
        leaseResult.kind === 'max_turns_reached'
      ) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        errorJson(res, 410, 'Conversation is no longer valid');
        return;
      }
      if (leaseResult.kind === 'lease_active') {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        errorJson(res, 409, 'Already processing');
        return;
      }

      const conversationDoc = leaseResult.doc;

      const wavCheck = validateWav(audioBuffer);
      if (!wavCheck.ok) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        await deps.conversationRepo.releaseLeaseBackToAwaiting(conversationId, deps.clock.now());
        const status = wavCheck.reason === 'too_large' ? 413 : 400;
        errorJson(res, status, 'Invalid audio');
        return;
      }

      const nowLocal = nowLocalIsoTokyo(deps.clock);
      const missingField = conversationDoc.missingField ?? 'title';
      const systemInstruction = buildFollowupSystemInstruction({
        nowLocalIso: nowLocal,
        partialCandidate: conversationDoc.partialCandidate,
        missingField,
        turnCount: conversationDoc.turnCount,
        maxTurns: MAX_TURNS,
      });
      const audioBase64 = audioBuffer.toString('base64');
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), geminiTimeoutMs);

      let rawJson: string | undefined;
      try {
        rawJson = await deps.geminiClient.generateFollowupResultJson({
          audioBase64,
          systemInstruction,
          abortSignal: abortController.signal,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        await deps.conversationRepo.releaseLeaseBackToAwaiting(conversationId, deps.clock.now());
        const isAbort = err instanceof Error && err.name === 'AbortError';
        logSanitizedError('plugin_analyze_followup_audio_gemini_call_failed', err, {
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

      const parsed = parsedRaw !== undefined ? parseFollowupFragmentResult(parsedRaw) : null;
      if (!parsed) {
        await deps.requestDedupeRepo.markStatus(requestKeyHash, 'failed', deps.clock.now());
        await deps.conversationRepo.releaseLeaseBackToAwaiting(conversationId, deps.clock.now());
        logSafeEvent({
          event: 'plugin_analyze_followup_audio_schema_invalid',
          geminiModel: deps.geminiModel,
          vertexLocation: deps.vertexLocation,
        });
        errorJson(res, 502, 'Model failure');
        return;
      }

      const existingFragments: CandidateFragments = {
        title: conversationDoc.partialCandidate.title,
        dateLocal: conversationDoc.partialCandidate.dateLocal,
        startTimeLocal: conversationDoc.partialCandidate.startTimeLocal,
        durationMinutes: conversationDoc.partialCandidate.durationMinutes,
        endDateLocal: conversationDoc.partialCandidate.endDateLocal,
        allDaySignal: conversationDoc.partialCandidate.allDaySignal,
      };
      const resolved = resolveCandidate(existingFragments, parsed, nowLocal);
      const result: FollowupResult = {
        schemaVersion: '1',
        resultType: resolved.resultType,
        title: resolved.title,
        startLocal: resolved.startLocal,
        endLocal: resolved.endLocal,
        timeZone: resolved.timeZone,
        allDay: resolved.allDay,
        clarificationField: resolved.clarificationField,
        clarificationQuestion: resolved.clarificationQuestion,
        assumptions: resolved.assumptions,
        // startDate/endDateExclusiveは終日候補完成時のみキーを含める(FollowupResultの規約)。
        ...(resolved.startDate !== null ? { startDate: resolved.startDate, endDateExclusive: resolved.endDateExclusive as string } : {}),
      };

      await deps.requestDedupeRepo.markStatus(requestKeyHash, 'completed', deps.clock.now());

      let candidateId: string | null = null;
      let nextTurn: number | null = null;

      if (
        result.resultType === 'event_candidate' &&
        ((result.startLocal && result.endLocal) || (result.startDate && result.endDateExclusive))
      ) {
        await deps.conversationRepo.markCompleted(conversationId, deps.clock.now());
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
        const exhausted = conversationDoc.turnCount + 1 >= MAX_TURNS;
        if (exhausted) {
          await deps.conversationRepo.markCancelled(conversationId, deps.clock.now());
          result.resultType = 'cancelled';
        } else {
          await deps.conversationRepo.recordNextClarification({
            conversationId,
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
            now: deps.clock.now(),
          });
          nextTurn = conversationDoc.turnCount + 2; // turnCountは0始まり、turnは1始まりの表示用
        }
      } else {
        // cancelled または not_calendar_request: 会話を終了する
        await deps.conversationRepo.markCancelled(conversationId, deps.clock.now());
      }

      logSafeEvent({
        event: 'plugin_analyze_followup_audio_succeeded',
        sessionHashPrefix: shortHashPrefix(tokenHash),
        conversationHashPrefix: shortHashPrefix(hashValue(conversationId)),
        turnCount: conversationDoc.turnCount,
        ...(conversationDoc.missingField !== null ? { missingField: conversationDoc.missingField } : {}),
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
        conversationId,
        result,
        candidateId,
        turn: nextTurn,
        maxTurns: nextTurn !== null ? MAX_TURNS : null,
      });
    },
  );

  return router;
}
