import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Clock } from '../time/clock.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { sanitizeError } from '../security/sanitizedError.js';
import { hashValue, shortHashPrefix } from '../security/devSessionToken.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';
import type { PluginRateLimitRepository } from '../firestore/pluginRateLimitRepository.js';
import type { IdempotencyRepository } from '../firestore/idempotencyRepository.js';
import type { CalendarService } from '../calendar/calendarService.js';
import type { CalendarEventFullDetail } from '../calendar/calendarClient.js';
import { toEventDetailResponseItem } from '../calendar/eventResponseMapping.js';
import { localeFromQuery } from '../i18n/locale.js';
import { resolvePrincipal } from '../product/principal.js';
import type { ProductInstallationRepository } from '../product/productInstallationRepository.js';
import { classifyProductCalendarError } from '../product/productCalendarErrorClassifier.js';
import { updateCalendarEvent, deleteCalendarEvent, type UpdateEventRequestFields } from '../services/pluginCalendarEventMutationService.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Google Calendar event IDに加え、singleEvents展開後の定期予定インスタンスID(originalId_20260101T090000Z形式)も許容する。 */
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{5,1024}$/;
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_TITLE_LENGTH = 1;
const MAX_TITLE_LENGTH = 120;
const MAX_LOCATION_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;
const DEFAULT_CALENDAR_TIMEOUT_MS = 10_000;

export interface PluginCalendarEventsItemRouterDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
  rateLimitRepo: PluginRateLimitRepository;
  idempotencyRepo: IdempotencyRepository;
  calendarId: string;
  resolveCalendarService: (userId?: string | null) => Promise<CalendarService | null>;
  /** device session(Phase 2H)のtokenVersion/installation失効確認に使う。dev専用利用時は省略可。 */
  productInstallationRepo?: ProductInstallationRepository;
  rateLimitPerMinute?: number;
  calendarTimeoutMs?: number;
}

interface UpdateEventBody {
  idempotencyKey?: unknown;
  title?: unknown;
  location?: unknown;
  description?: unknown;
  startLocal?: unknown;
  endLocal?: unknown;
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

/** bodyの型・パターンを検証し、サービス層へ渡す{idempotencyKey, fields}へ変換する。1件も更新対象フィールドが無ければ不正とする。 */
function parseUpdateBody(body: UpdateEventBody | undefined): { idempotencyKey: string; fields: UpdateEventRequestFields } | null {
  if (!body) return null;
  if (typeof body.idempotencyKey !== 'string' || !UUID_PATTERN.test(body.idempotencyKey)) return null;

  const fields: UpdateEventRequestFields = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.length < MIN_TITLE_LENGTH || body.title.length > MAX_TITLE_LENGTH) return null;
    fields.title = body.title;
  }
  if (body.location !== undefined) {
    if (typeof body.location !== 'string' || body.location.length > MAX_LOCATION_LENGTH) return null;
    fields.location = body.location;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > MAX_DESCRIPTION_LENGTH) return null;
    fields.description = body.description;
  }
  if (body.startLocal !== undefined) {
    if (typeof body.startLocal !== 'string' || !LOCAL_DATETIME_PATTERN.test(body.startLocal)) return null;
    fields.startLocal = body.startLocal;
  }
  if (body.endLocal !== undefined) {
    if (typeof body.endLocal !== 'string' || !LOCAL_DATETIME_PATTERN.test(body.endLocal)) return null;
    fields.endLocal = body.endLocal;
  }
  if (body.allDay !== undefined) {
    if (typeof body.allDay !== 'boolean') return null;
    fields.allDay = body.allDay;
  }
  if (body.startDate !== undefined) {
    if (typeof body.startDate !== 'string' || !DATE_ONLY_PATTERN.test(body.startDate)) return null;
    fields.startDate = body.startDate;
  }
  if (body.endDateExclusive !== undefined) {
    if (typeof body.endDateExclusive !== 'string' || !DATE_ONLY_PATTERN.test(body.endDateExclusive)) return null;
    fields.endDateExclusive = body.endDateExclusive;
  }

  // locale を fields に入れてはならない。入れると (a) locale だけの PATCH が空 PATCH として検出
  // されなくなり、(b) 逆に locale を fields の外で必須化すると locale 単独 PATCH が誤って 400 に
  // なる。将来 PATCH レスポンスのローカライズが必要になったら、戻り値を
  // {idempotencyKey, fields, locale} に拡張し、locale はこの空チェックより前に別変数へ退避すること。
  if (Object.keys(fields).length === 0) return null;

  return { idempotencyKey: body.idempotencyKey, fields };
}

export function createPluginCalendarEventsItemRouter(deps: PluginCalendarEventsItemRouterDeps): Router {
  const router = Router();
  const rateLimitPerMinute = deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const calendarTimeoutMs = deps.calendarTimeoutMs ?? DEFAULT_CALENDAR_TIMEOUT_MS;

  router.options('/plugin/calendar-events/:eventId', corsHeaders('GET, PATCH, DELETE, OPTIONS'), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.get('/plugin/calendar-events/:eventId', corsHeaders('GET, PATCH, DELETE, OPTIONS'), async (req: Request, res: Response) => {
    const startedAt = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const auth = await resolvePrincipal(
      req,
      {
        clock: deps.clock,
        pluginSessionRepo: deps.pluginSessionRepo,
        ...(deps.productInstallationRepo ? { productInstallationRepo: deps.productInstallationRepo } : {}),
      },
      'calendar:read',
    );
    if (!auth.ok) {
      errorJson(res, auth.status, auth.status === 401 ? 'Unauthorized' : auth.status === 403 ? 'Forbidden' : 'Bad Request');
      return;
    }
    const tokenHash = auth.principal.tokenHash;

    const requestId = req.header('x-request-id');
    if (!requestId || !UUID_PATTERN.test(requestId)) {
      errorJson(res, 400, 'X-Request-Id header is required');
      return;
    }

    const eventId = req.params.eventId ?? '';
    if (!EVENT_ID_PATTERN.test(eventId)) {
      errorJson(res, 400, 'Invalid eventId');
      return;
    }
    const eventIdHashPrefix = shortHashPrefix(hashValue(eventId));

    const now = deps.clock.now();
    const rateLimitResult = await deps.rateLimitRepo.consume({
      sessionKey: `${tokenHash}:calendar-event-detail`,
      now,
      limit: rateLimitPerMinute,
    });
    logSafeEvent({
      event: 'plugin_calendar_event_detail_rate_limit_checked',
      sessionHashPrefix: shortHashPrefix(tokenHash),
      eventIdHashPrefix,
      rateLimitAllowed: rateLimitResult.allowed,
    });
    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', String(rateLimitResult.retryAfterSeconds));
      errorJson(res, 429, 'Too Many Requests');
      return;
    }

    const calendarService = await deps.resolveCalendarService(auth.principal.userId);
    if (!calendarService) {
      errorJson(res, 403, 'Forbidden');
      return;
    }

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), calendarTimeoutMs);

    let detail: CalendarEventFullDetail | null;
    try {
      detail = await calendarService.getEventDetail(deps.calendarId, eventId, abortController.signal);
    } catch (err) {
      clearTimeout(timeoutHandle);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const sanitizedErrorCode = auth.principal.userId ? classifyProductCalendarError(err) : sanitizeError(err);
      logSafeEvent({
        event: 'plugin_calendar_event_detail_calendar_call_failed',
        level: 'error',
        sessionHashPrefix: shortHashPrefix(tokenHash),
        eventIdHashPrefix,
        sanitizedErrorCode,
      });
      errorJson(res, isAbort ? 504 : 502, isAbort ? 'Calendar API timeout' : 'Calendar API failure');
      return;
    }
    clearTimeout(timeoutHandle);

    if (!detail) {
      logSafeEvent({
        event: 'plugin_calendar_event_detail_not_found',
        sessionHashPrefix: shortHashPrefix(tokenHash),
        eventIdHashPrefix,
      });
      errorJson(res, 404, 'Event not found');
      return;
    }

    const locale = localeFromQuery(req.query);
    const event = toEventDetailResponseItem(detail, locale);
    logSafeEvent({
      event: 'plugin_calendar_event_detail_succeeded',
      sessionHashPrefix: shortHashPrefix(tokenHash),
      eventIdHashPrefix,
      latencyMs: Date.now() - startedAt,
      httpStatus: 200,
    });
    res.status(200).json({ schemaVersion: '1', event });
  });

  router.patch('/plugin/calendar-events/:eventId', corsHeaders('GET, PATCH, DELETE, OPTIONS'), async (req: Request, res: Response) => {
    const startedAt = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const auth = await resolvePrincipal(
      req,
      {
        clock: deps.clock,
        pluginSessionRepo: deps.pluginSessionRepo,
        ...(deps.productInstallationRepo ? { productInstallationRepo: deps.productInstallationRepo } : {}),
      },
      'calendar:update',
    );
    if (!auth.ok) {
      errorJson(res, auth.status, auth.status === 401 ? 'Unauthorized' : auth.status === 403 ? 'Forbidden' : 'Bad Request');
      return;
    }
    const tokenHash = auth.principal.tokenHash;

    const requestId = req.header('x-request-id');
    if (!requestId || !UUID_PATTERN.test(requestId)) {
      errorJson(res, 400, 'X-Request-Id header is required');
      return;
    }

    const eventId = req.params.eventId ?? '';
    if (!EVENT_ID_PATTERN.test(eventId)) {
      errorJson(res, 400, 'Invalid eventId');
      return;
    }
    const eventIdHashPrefix = shortHashPrefix(hashValue(eventId));

    const parsed = parseUpdateBody(req.body as UpdateEventBody | undefined);
    if (!parsed) {
      errorJson(res, 400, 'Invalid request body');
      return;
    }
    const idempotencyKeyHashPrefix = shortHashPrefix(hashValue(parsed.idempotencyKey));

    const now = deps.clock.now();
    const rateLimitResult = await deps.rateLimitRepo.consume({
      sessionKey: `${tokenHash}:calendar-event-update`,
      now,
      limit: rateLimitPerMinute,
    });
    logSafeEvent({
      event: 'plugin_calendar_event_update_rate_limit_checked',
      sessionHashPrefix: shortHashPrefix(tokenHash),
      eventIdHashPrefix,
      rateLimitAllowed: rateLimitResult.allowed,
    });
    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', String(rateLimitResult.retryAfterSeconds));
      errorJson(res, 429, 'Too Many Requests');
      return;
    }

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), calendarTimeoutMs);

    const outcome = await updateCalendarEvent(
      { clock: deps.clock, idempotencyRepo: deps.idempotencyRepo, calendarId: deps.calendarId, resolveCalendarService: deps.resolveCalendarService },
      { idempotencyKey: parsed.idempotencyKey, eventId, fields: parsed.fields, userId: auth.principal.userId, abortSignal: abortController.signal },
    );
    clearTimeout(timeoutHandle);

    logSafeEvent({
      event: 'plugin_calendar_event_update',
      level: outcome.kind === 'success' ? 'info' : 'error',
      command: 'calendar_update',
      sessionHashPrefix: shortHashPrefix(tokenHash),
      eventIdHashPrefix,
      idempotencyKeyHashPrefix,
      status: outcome.kind,
      leaseAcquired: outcome.leaseAcquired,
      reusedCompletedResult: outcome.reusedCompletedResult,
      latencyMs: Date.now() - startedAt,
      ...(outcome.sanitizedErrorCode !== null ? { sanitizedErrorCode: outcome.sanitizedErrorCode } : {}),
    });

    switch (outcome.kind) {
      case 'success':
        res.status(200).json({ eventId: outcome.eventId, status: 'updated' });
        return;
      case 'already_processing':
        errorJson(res, 409, 'Already processing');
        return;
      case 'not_found':
        errorJson(res, 404, 'Event not found');
        return;
      case 'invalid_range':
        errorJson(res, 400, 'start must be before end');
        return;
      case 'conflict':
        errorJson(res, 409, 'Event was modified by another request');
        return;
      case 'oauth_not_connected':
        errorJson(res, 503, 'Calendar not connected');
        return;
      case 'timeout':
        errorJson(res, 504, 'Calendar API timeout');
        return;
      case 'calendar_error':
      default:
        errorJson(res, 502, 'Update failed');
        return;
    }
  });

  router.delete('/plugin/calendar-events/:eventId', corsHeaders('GET, PATCH, DELETE, OPTIONS'), async (req: Request, res: Response) => {
    const startedAt = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const auth = await resolvePrincipal(
      req,
      {
        clock: deps.clock,
        pluginSessionRepo: deps.pluginSessionRepo,
        ...(deps.productInstallationRepo ? { productInstallationRepo: deps.productInstallationRepo } : {}),
      },
      'calendar:delete',
    );
    if (!auth.ok) {
      errorJson(res, auth.status, auth.status === 401 ? 'Unauthorized' : auth.status === 403 ? 'Forbidden' : 'Bad Request');
      return;
    }
    const tokenHash = auth.principal.tokenHash;

    const requestId = req.header('x-request-id');
    if (!requestId || !UUID_PATTERN.test(requestId)) {
      errorJson(res, 400, 'X-Request-Id header is required');
      return;
    }

    const eventId = req.params.eventId ?? '';
    if (!EVENT_ID_PATTERN.test(eventId)) {
      errorJson(res, 400, 'Invalid eventId');
      return;
    }
    const eventIdHashPrefix = shortHashPrefix(hashValue(eventId));

    const idempotencyKeyParam = req.query.idempotencyKey;
    const idempotencyKey = typeof idempotencyKeyParam === 'string' ? idempotencyKeyParam : '';
    if (!UUID_PATTERN.test(idempotencyKey)) {
      errorJson(res, 400, 'idempotencyKey query parameter is required');
      return;
    }
    const idempotencyKeyHashPrefix = shortHashPrefix(hashValue(idempotencyKey));

    const now = deps.clock.now();
    const rateLimitResult = await deps.rateLimitRepo.consume({
      sessionKey: `${tokenHash}:calendar-event-delete`,
      now,
      limit: rateLimitPerMinute,
    });
    logSafeEvent({
      event: 'plugin_calendar_event_delete_rate_limit_checked',
      sessionHashPrefix: shortHashPrefix(tokenHash),
      eventIdHashPrefix,
      rateLimitAllowed: rateLimitResult.allowed,
    });
    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', String(rateLimitResult.retryAfterSeconds));
      errorJson(res, 429, 'Too Many Requests');
      return;
    }

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), calendarTimeoutMs);

    const outcome = await deleteCalendarEvent(
      { clock: deps.clock, idempotencyRepo: deps.idempotencyRepo, calendarId: deps.calendarId, resolveCalendarService: deps.resolveCalendarService },
      { idempotencyKey, eventId, userId: auth.principal.userId, abortSignal: abortController.signal },
    );
    clearTimeout(timeoutHandle);

    logSafeEvent({
      event: 'plugin_calendar_event_delete',
      level: outcome.kind === 'success' ? 'info' : 'error',
      command: 'calendar_delete',
      sessionHashPrefix: shortHashPrefix(tokenHash),
      eventIdHashPrefix,
      idempotencyKeyHashPrefix,
      status: outcome.kind,
      leaseAcquired: outcome.leaseAcquired,
      reusedCompletedResult: outcome.reusedCompletedResult,
      latencyMs: Date.now() - startedAt,
      ...(outcome.sanitizedErrorCode !== null ? { sanitizedErrorCode: outcome.sanitizedErrorCode } : {}),
    });

    switch (outcome.kind) {
      case 'success':
        res.status(200).json({ eventId: outcome.eventId, status: 'deleted' });
        return;
      case 'already_processing':
        errorJson(res, 409, 'Already processing');
        return;
      case 'oauth_not_connected':
        errorJson(res, 503, 'Calendar not connected');
        return;
      case 'timeout':
        errorJson(res, 504, 'Calendar API timeout');
        return;
      case 'not_found':
      case 'invalid_range':
      case 'conflict':
      case 'calendar_error':
      default:
        errorJson(res, 502, 'Delete failed');
        return;
    }
  });

  return router;
}
