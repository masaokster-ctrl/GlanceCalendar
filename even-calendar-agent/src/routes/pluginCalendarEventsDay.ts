import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Clock } from '../time/clock.js';
import { todayRangeTokyo, tomorrowRangeTokyo } from '../time/tokyoDateTime.js';
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
const DAY_VALUES = ['today', 'tomorrow'] as const;
type Day = (typeof DAY_VALUES)[number];

export interface PluginCalendarEventsDayRouterDeps {
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

export function createPluginCalendarEventsDayRouter(deps: PluginCalendarEventsDayRouterDeps): Router {
  const router = Router();
  const rateLimitPerMinute = deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const calendarTimeoutMs = deps.calendarTimeoutMs ?? DEFAULT_CALENDAR_TIMEOUT_MS;

  router.options('/plugin/calendar-events/day', corsHeaders('GET, OPTIONS'), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.get('/plugin/calendar-events/day', corsHeaders('GET, OPTIONS'), async (req: Request, res: Response) => {
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
    const tokenHash = auth.principal.tokenHash;

    const requestId = req.header('x-request-id');
    if (!requestId || !UUID_PATTERN.test(requestId)) {
      errorJson(res, 400, 'X-Request-Id header is required');
      return;
    }

    const allowedQueryKeys = new Set(['day']);
    if (Object.keys(req.query).some((key) => !allowedQueryKeys.has(key))) {
      errorJson(res, 400, 'Only the day query parameter is supported');
      return;
    }

    const dayParam = req.query.day;
    if (typeof dayParam !== 'string' || !DAY_VALUES.includes(dayParam as Day)) {
      errorJson(res, 400, 'day must be "today" or "tomorrow"');
      return;
    }
    const day = dayParam as Day;

    const now = deps.clock.now();
    const rateLimitResult = await deps.rateLimitRepo.consume({
      sessionKey: `${tokenHash}:calendar-events-day`,
      now,
      limit: rateLimitPerMinute,
    });
    logSafeEvent({
      event: 'plugin_calendar_events_day_rate_limit_checked',
      sessionHashPrefix: shortHashPrefix(tokenHash),
      day,
      rateLimitAllowed: rateLimitResult.allowed,
    });
    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', String(rateLimitResult.retryAfterSeconds));
      errorJson(res, 429, 'Too Many Requests');
      return;
    }

    const range = day === 'today' ? todayRangeTokyo(deps.clock) : tomorrowRangeTokyo(deps.clock);
    const dateLocal = range.start.toFormat('yyyy-MM-dd');

    const calendarService = await deps.resolveCalendarService(auth.principal.userId);
    if (!calendarService) {
      errorJson(res, 403, 'Forbidden');
      return;
    }

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), calendarTimeoutMs);

    let dayEvents: { events: CalendarEventDetail[]; truncated: boolean };
    try {
      dayEvents = await calendarService.listEventsDetailedForDayRange({
        calendarId: deps.calendarId,
        start: range.start,
        end: range.end,
        abortSignal: abortController.signal,
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const sanitizedErrorCode = auth.principal.userId ? classifyProductCalendarError(err) : sanitizeError(err);
      logSafeEvent({
        event: 'plugin_calendar_events_day_calendar_call_failed',
        level: 'error',
        sessionHashPrefix: shortHashPrefix(tokenHash),
        day,
        sanitizedErrorCode,
      });
      errorJson(res, isAbort ? 504 : 502, isAbort ? 'Calendar API timeout' : 'Calendar API failure');
      return;
    }
    clearTimeout(timeoutHandle);

    const events = dayEvents.events.map(toEventResponseItem);
    const allDayCount = events.filter((event) => event.allDay).length;
    const timedCount = events.length - allDayCount;

    logSafeEvent({
      event: 'plugin_calendar_events_day_succeeded',
      sessionHashPrefix: shortHashPrefix(tokenHash),
      day,
      resultCount: events.length,
      allDayCount,
      timedCount,
      truncated: dayEvents.truncated,
      latencyMs: Date.now() - startedAt,
      httpStatus: 200,
    });

    res.status(200).json({
      schemaVersion: '1',
      day,
      dateLocal,
      timeZone: 'Asia/Tokyo',
      events,
      truncated: dayEvents.truncated,
    });
  });

  return router;
}
