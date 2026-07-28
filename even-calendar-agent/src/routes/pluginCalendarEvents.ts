import { Router, type Request, type RequestHandler, type Response } from 'express';
import { DateTime } from 'luxon';
import type { Clock } from '../time/clock.js';
import { TOKYO_ZONE } from '../time/tokyoDateTime.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { hashValue, shortHashPrefix } from '../security/devSessionToken.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';
import type { PluginEventCandidateRepository } from '../firestore/pluginEventCandidateRepository.js';
import { registerCandidateEvent, type RegisterCandidateDeps } from '../services/pluginCalendarRegistrationService.js';
import { resolvePrincipal } from '../product/principal.js';
import type { ProductInstallationRepository } from '../product/productInstallationRepository.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_TITLE_LENGTH = 1;
const MAX_TITLE_LENGTH = 120;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_DAYS = 365;

export interface PluginCalendarEventsRouterDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
  candidateRepo: PluginEventCandidateRepository;
  resolveCalendarService: RegisterCandidateDeps['resolveCalendarService'];
  /** device session(Phase 2H)のtokenVersion/installation失効確認に使う。dev専用利用時は省略可。 */
  productInstallationRepo?: ProductInstallationRepository;
}

interface RegisterBody {
  schemaVersion?: unknown;
  candidateId?: unknown;
  title?: unknown;
  startLocal?: unknown;
  endLocal?: unknown;
  timeZone?: unknown;
  allDay?: unknown;
  startDate?: unknown;
  endDateExclusive?: unknown;
}

function corsHeaders(methods: string): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Install-Id, X-Request-Id');
    next();
  };
}

function errorJson(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error' } });
}

/**
 * allDay===falseの時は既存どおりstartLocal/endLocalが必須の日時文字列(startLocal/endLocalの
 * 意味はタイムゾーン付きローカル日時)。allDay===trueの時はstartDate/endDateExclusiveが必須の
 * YYYY-MM-DD文字列(startDate < endDateExclusive、endDateExclusiveはGoogle API方式の排他的終了日)
 * で、startLocal/endLocalは未指定またはnullであることを要求する(両方は許容しない=フィールド混在を防ぐ)。
 */
type ValidRegisterBody =
  | {
      schemaVersion: '1';
      candidateId: string;
      title: string;
      timeZone: string;
      allDay: false;
      startLocal: string;
      endLocal: string;
      startDate?: null;
      endDateExclusive?: null;
    }
  | {
      schemaVersion: '1';
      candidateId: string;
      title: string;
      timeZone: string;
      allDay: true;
      startDate: string;
      endDateExclusive: string;
      startLocal?: null;
      endLocal?: null;
    };

/**
 * 0.2.1以前の旧プラグインがPOSTボディに`allDay`フィールドを送らない可能性への防御的な
 * 後方互換レイヤー(2026-07-28 管理者判断)。`allDay`が未指定で、かつ`startLocal`/`endLocal`
 * が両方とも有効な日時文字列であり、`startDate`/`endDateExclusive`が両方とも未指定
 * (またはnull、終日フィールドとの混在なし)の場合に限り、`allDay: false`を補ったボディへ
 * 正規化する。この関数は「allDay:falseの新形式ボディを模倣する」だけであり、終日予定への
 * 推測変換は行わない(常にfalse方向のみ)。条件を満たさない場合は元のボディをそのまま返し、
 * 以降の`isValidBodyShape`による既存の検証(startDate/endDateExclusive混在の拒否含む)に委ねる。
 */
function normalizeLegacyAllDayOmittedBody(body: RegisterBody | undefined): RegisterBody | undefined {
  if (!body) return body;
  if (body.allDay !== undefined) return body;
  if (body.startDate !== undefined && body.startDate !== null) return body;
  if (body.endDateExclusive !== undefined && body.endDateExclusive !== null) return body;
  if (typeof body.startLocal !== 'string' || !LOCAL_DATETIME_PATTERN.test(body.startLocal)) return body;
  if (typeof body.endLocal !== 'string' || !LOCAL_DATETIME_PATTERN.test(body.endLocal)) return body;
  return { ...body, allDay: false };
}

function isValidBodyShape(body: RegisterBody | undefined): body is ValidRegisterBody {
  if (!body) return false;
  if (body.schemaVersion !== '1') return false;
  if (typeof body.candidateId !== 'string' || !UUID_PATTERN.test(body.candidateId)) return false;
  if (typeof body.title !== 'string' || body.title.length < MIN_TITLE_LENGTH || body.title.length > MAX_TITLE_LENGTH) return false;
  if (body.timeZone !== 'Asia/Tokyo') return false;

  if (body.allDay === true) {
    if (body.startLocal !== undefined && body.startLocal !== null) return false;
    if (body.endLocal !== undefined && body.endLocal !== null) return false;
    if (typeof body.startDate !== 'string' || !DATE_ONLY_PATTERN.test(body.startDate)) return false;
    if (typeof body.endDateExclusive !== 'string' || !DATE_ONLY_PATTERN.test(body.endDateExclusive)) return false;
    if (!(body.startDate < body.endDateExclusive)) return false;
    return true;
  }

  if (body.allDay !== false) return false;
  if (body.startDate !== undefined && body.startDate !== null) return false;
  if (body.endDateExclusive !== undefined && body.endDateExclusive !== null) return false;
  if (typeof body.startLocal !== 'string' || !LOCAL_DATETIME_PATTERN.test(body.startLocal)) return false;
  if (typeof body.endLocal !== 'string' || !LOCAL_DATETIME_PATTERN.test(body.endLocal)) return false;
  return true;
}

function isWithinBusinessRules(startLocal: string, endLocal: string, now: Date): boolean {
  const start = DateTime.fromISO(startLocal, { zone: TOKYO_ZONE });
  const end = DateTime.fromISO(endLocal, { zone: TOKYO_ZONE });
  if (!start.isValid || !end.isValid) return false;

  const nowMs = now.getTime();
  const startMs = start.toMillis();
  const endMs = end.toMillis();

  if (startMs <= nowMs) return false;
  if (endMs <= startMs) return false;
  if (endMs - startMs > MAX_DURATION_MS) return false;
  if (startMs - nowMs > MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000) return false;
  return true;
}

/**
 * 終日候補(allDay:true)の業務ルール検証。startDate/endDateExclusiveはYYYY-MM-DDのGoogle API方式
 * 排他的終了日。過去日拒否・最大未来日数(MAX_FUTURE_DAYS)は通常予定(isWithinBusinessRules)の
 * 既存ルールをallDayに合わせて適用し、開始>=終了(逆転期間)の拒否を行う。終日レンジの最大日数制限
 * は既存仕様・ユーザー要件に根拠がないため設けていない(2026-07-27 管理者判断、未対応事項として報告)。
 */
function isWithinAllDayBusinessRules(startDate: string, endDateExclusive: string, now: Date): boolean {
  const start = DateTime.fromISO(startDate, { zone: TOKYO_ZONE });
  const end = DateTime.fromISO(endDateExclusive, { zone: TOKYO_ZONE });
  if (!start.isValid || !end.isValid) return false;

  const today = DateTime.fromJSDate(now, { zone: TOKYO_ZONE }).startOf('day');

  if (start < today) return false;
  if (!(start < end)) return false;

  const maxFutureStart = today.plus({ days: MAX_FUTURE_DAYS });
  if (start > maxFutureStart) return false;

  return true;
}

export function createPluginCalendarEventsRouter(deps: PluginCalendarEventsRouterDeps): Router {
  const router = Router();

  router.options('/plugin/calendar-events', corsHeaders('POST, OPTIONS'), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.post('/plugin/calendar-events', corsHeaders('POST, OPTIONS'), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const startedAt = Date.now();

    const auth = await resolvePrincipal(
      req,
      {
        clock: deps.clock,
        pluginSessionRepo: deps.pluginSessionRepo,
        ...(deps.productInstallationRepo ? { productInstallationRepo: deps.productInstallationRepo } : {}),
      },
      'calendar:create',
    );
    if (!auth.ok) {
      errorJson(res, auth.status, auth.status === 401 ? 'Unauthorized' : auth.status === 403 ? 'Forbidden' : 'Bad Request');
      return;
    }

    const requestId = req.header('x-request-id');
    if (!requestId || !UUID_PATTERN.test(requestId)) {
      errorJson(res, 400, 'X-Request-Id header is required');
      return;
    }

    const body = normalizeLegacyAllDayOmittedBody(req.body as RegisterBody | undefined);
    if (!isValidBodyShape(body)) {
      errorJson(res, 400, 'Invalid request body');
      return;
    }

    const candidate = await deps.candidateRepo.get(body.candidateId);
    const now = deps.clock.now();

    if (!candidate) {
      errorJson(res, 410, 'Candidate is no longer valid');
      return;
    }
    if (candidate.sessionHash !== auth.principal.tokenHash || candidate.installIdHash !== hashValue(auth.principal.installId)) {
      errorJson(res, 403, 'Forbidden');
      return;
    }
    if (candidate.status === 'pending' && candidate.expiresAt.getTime() <= now.getTime()) {
      errorJson(res, 410, 'Candidate is no longer valid');
      return;
    }
    const matchesCandidate =
      candidate.title === body.title &&
      candidate.timeZone === body.timeZone &&
      candidate.allDay === body.allDay &&
      (body.allDay
        ? candidate.startDate === body.startDate && candidate.endDateExclusive === body.endDateExclusive
        : candidate.startLocal === body.startLocal && candidate.endLocal === body.endLocal);
    if (!matchesCandidate) {
      errorJson(res, 400, 'Request body does not match the stored candidate');
      return;
    }
    if (candidate.allDay) {
      if (
        candidate.startDate === null ||
        candidate.endDateExclusive === null ||
        !isWithinAllDayBusinessRules(candidate.startDate, candidate.endDateExclusive, now)
      ) {
        errorJson(res, 410, 'Candidate is no longer valid');
        return;
      }
    } else {
      if (candidate.startLocal === null || candidate.endLocal === null || !isWithinBusinessRules(candidate.startLocal, candidate.endLocal, now)) {
        errorJson(res, 410, 'Candidate is no longer valid');
        return;
      }
    }

    const outcome = await registerCandidateEvent(
      { clock: deps.clock, candidateRepo: deps.candidateRepo, resolveCalendarService: deps.resolveCalendarService },
      body.candidateId,
      auth.principal.userId,
    );

    logSafeEvent({
      event: 'plugin_calendar_event_register',
      command: 'calendar_create',
      candidateHashPrefix: shortHashPrefix(hashValue(body.candidateId)),
      status: outcome.kind,
      leaseAcquired: outcome.leaseAcquired,
      reusedCompletedResult: outcome.reusedCompletedResult,
      latencyMs: Date.now() - startedAt,
      ...(outcome.calendarApiOperation !== null ? { calendarApiOperation: outcome.calendarApiOperation } : {}),
      ...(outcome.sanitizedErrorCode !== null ? { sanitizedErrorCode: outcome.sanitizedErrorCode } : {}),
    });

    switch (outcome.kind) {
      case 'success':
        res.status(200).json({ candidateId: body.candidateId, status: 'completed' });
        return;
      case 'candidate_invalid':
        errorJson(res, 410, 'Candidate is no longer valid');
        return;
      case 'already_processing':
        errorJson(res, 409, 'Already processing');
        return;
      case 'already_failed':
        errorJson(res, 502, 'Registration failed');
        return;
      case 'oauth_not_connected':
        errorJson(res, 503, 'Calendar not connected');
        return;
      case 'calendar_error':
      default:
        errorJson(res, 502, 'Registration failed');
        return;
    }
  });

  router.options('/plugin/calendar-events/status', corsHeaders('GET, OPTIONS'), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.get('/plugin/calendar-events/status', corsHeaders('GET, OPTIONS'), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const auth = await resolvePrincipal(
      req,
      {
        clock: deps.clock,
        pluginSessionRepo: deps.pluginSessionRepo,
        ...(deps.productInstallationRepo ? { productInstallationRepo: deps.productInstallationRepo } : {}),
      },
      'calendar:status',
    );
    if (!auth.ok) {
      errorJson(res, auth.status, auth.status === 401 ? 'Unauthorized' : auth.status === 403 ? 'Forbidden' : 'Bad Request');
      return;
    }

    const candidateIdParam = req.query.candidateId;
    const candidateId = typeof candidateIdParam === 'string' ? candidateIdParam : '';
    if (!UUID_PATTERN.test(candidateId)) {
      errorJson(res, 400, 'candidateId query parameter is required');
      return;
    }

    const candidate = await deps.candidateRepo.get(candidateId);
    const now = deps.clock.now();

    logSafeEvent({
      event: 'plugin_calendar_event_status_checked',
      command: 'calendar_status',
      candidateHashPrefix: shortHashPrefix(hashValue(candidateId)),
    });

    if (!candidate || candidate.sessionHash !== auth.principal.tokenHash || candidate.installIdHash !== hashValue(auth.principal.installId)) {
      res.status(200).json({ candidateId, status: 'expired' });
      return;
    }

    const effectiveStatus =
      candidate.status === 'pending' && candidate.expiresAt.getTime() <= now.getTime() ? 'expired' : candidate.status;

    res.status(200).json({ candidateId, status: effectiveStatus });
  });

  return router;
}
