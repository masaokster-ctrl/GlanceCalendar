import { Router, type Request, type RequestHandler, type Response } from 'express';
import { DateTime } from 'luxon';
import type { Clock } from '../time/clock.js';
import { TOKYO_ZONE } from '../time/tokyoDateTime.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { sanitizeError } from '../security/sanitizedError.js';
import { shortHashPrefix } from '../security/devSessionToken.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';
import type { PluginRateLimitRepository } from '../firestore/pluginRateLimitRepository.js';
import type { CalendarService } from '../calendar/calendarService.js';
import type { CalendarEventDetail } from '../calendar/calendarClient.js';
import { toEventResponseItem } from '../calendar/eventResponseMapping.js';
import { resolvePrincipal } from '../product/principal.js';
import type { ProductInstallationRepository } from '../product/productInstallationRepository.js';
import { classifyProductCalendarError } from '../product/productCalendarErrorClassifier.js';

const REQUIRED_SCOPE = 'calendar:read';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;
const DEFAULT_CALENDAR_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 5;
const MIN_LIMIT = 1;

export interface PluginCalendarEventsUpcomingRouterDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
  rateLimitRepo: PluginRateLimitRepository;
  calendarId: string;
  resolveCalendarService: (userId?: string | null) => Promise<CalendarService | null>;
  /** device session(Phase 2H)のtokenVersion/installation失効確認に使う。dev専用利用時は省略可。 */
  productInstallationRepo?: ProductInstallationRepository;
  rateLimitPerMinute?: number;
  calendarTimeoutMs?: number;
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

export function createPluginCalendarEventsUpcomingRouter(deps: PluginCalendarEventsUpcomingRouterDeps): Router {
  const router = Router();
  const rateLimitPerMinute = deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const calendarTimeoutMs = deps.calendarTimeoutMs ?? DEFAULT_CALENDAR_TIMEOUT_MS;

  router.options('/plugin/calendar-events/upcoming', corsHeaders('GET, OPTIONS'), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.get('/plugin/calendar-events/upcoming', corsHeaders('GET, OPTIONS'), async (req: Request, res: Response) => {
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
      REQUIRED_SCOPE,
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

    const allowedQueryKeys = new Set(['limit']);
    if (Object.keys(req.query).some((key) => !allowedQueryKeys.has(key))) {
      errorJson(res, 400, 'Only the limit query parameter is supported');
      return;
    }

    const limitParam = req.query.limit;
    let limit = DEFAULT_LIMIT;
    if (limitParam !== undefined) {
      if (typeof limitParam !== 'string' || !/^\d+$/.test(limitParam)) {
        errorJson(res, 400, 'limit must be an integer between 1 and 5');
        return;
      }
      const parsedLimit = Number(limitParam);
      if (parsedLimit < MIN_LIMIT || parsedLimit > MAX_LIMIT) {
        errorJson(res, 400, 'limit must be an integer between 1 and 5');
        return;
      }
      limit = parsedLimit;
    }

    const now = deps.clock.now();
    const rateLimitResult = await deps.rateLimitRepo.consume({
      sessionKey: `${auth.principal.tokenHash}:calendar-events-upcoming`,
      now,
      limit: rateLimitPerMinute,
    });
    logSafeEvent({
      event: 'plugin_calendar_events_upcoming_rate_limit_checked',
      sessionHashPrefix: shortHashPrefix(auth.principal.tokenHash),
      mode: 'upcoming',
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

    let upcomingEvents: { events: CalendarEventDetail[]; truncated: boolean };
    try {
      upcomingEvents = await calendarService.listUpcomingEvents({
        calendarId: deps.calendarId,
        now: DateTime.fromJSDate(now, { zone: TOKYO_ZONE }),
        limit,
        abortSignal: abortController.signal,
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const sanitizedErrorCode = auth.principal.userId ? classifyProductCalendarError(err) : sanitizeError(err);
      logSafeEvent({
        event: 'plugin_calendar_events_upcoming_calendar_call_failed',
        level: 'error',
        sessionHashPrefix: shortHashPrefix(auth.principal.tokenHash),
        mode: 'upcoming',
        sanitizedErrorCode,
      });
      errorJson(res, isAbort ? 504 : 502, isAbort ? 'Calendar API timeout' : 'Calendar API failure');
      return;
    }
    clearTimeout(timeoutHandle);

    const events = upcomingEvents.events.map(toEventResponseItem);
    const allDayCount = events.filter((event) => event.allDay).length;
    const timedCount = events.length - allDayCount;

    logSafeEvent({
      event: 'plugin_calendar_events_upcoming_succeeded',
      sessionHashPrefix: shortHashPrefix(auth.principal.tokenHash),
      mode: 'upcoming',
      resultCount: events.length,
      allDayCount,
      timedCount,
      truncated: upcomingEvents.truncated,
      latencyMs: Date.now() - startedAt,
      httpStatus: 200,
    });

    res.status(200).json({
      schemaVersion: '1',
      mode: 'upcoming',
      timeZone: 'Asia/Tokyo',
      events,
      truncated: upcomingEvents.truncated,
    });
  });

  return router;
}
