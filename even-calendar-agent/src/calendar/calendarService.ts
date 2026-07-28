import { DateTime } from 'luxon';
import { toRfc3339, toTokyoLocalFromIso, TOKYO_ZONE } from '../time/tokyoDateTime.js';
import type {
  CalendarClient,
  CalendarEventDetail,
  CalendarEventFullDetail,
  CalendarEventInput,
  CalendarEventSummary,
  PatchEventInput,
  PatchEventResult,
} from './calendarClient.js';

const DEFAULT_MAX_RESULTS = 20;
const DAY_EVENTS_MAX_TOTAL = 50;
const DAY_EVENTS_MAX_PAGES = 5; // 想定外の無限pagination化を防ぐ防御的上限
const UPCOMING_PAGE_SIZE = 20; // "安全な小さい値"。進行中/フィルタ除外分を見込んだページサイズ
const UPCOMING_MAX_PAGES = 5; // 防御的上限

export interface DayEventsResult {
  events: CalendarEventDetail[];
  truncated: boolean;
}

export interface UpcomingEventsResult {
  events: CalendarEventDetail[];
  truncated: boolean;
}

export interface CalendarService {
  listEventsForRange(params: { calendarId: string; start: DateTime; end: DateTime }): Promise<CalendarEventSummary[]>;
  listEventsDetailedForDayRange(params: {
    calendarId: string;
    start: DateTime;
    end: DateTime;
    abortSignal?: AbortSignal;
  }): Promise<DayEventsResult>;
  listUpcomingEvents(params: {
    calendarId: string;
    now: DateTime;
    limit: number;
    abortSignal?: AbortSignal;
  }): Promise<UpcomingEventsResult>;
  createEvent(input: CalendarEventInput): Promise<{ eventId: string }>;
  getEvent(calendarId: string, eventId: string): Promise<{ eventId: string } | null>;
  getEventDetail(calendarId: string, eventId: string, abortSignal?: AbortSignal): Promise<CalendarEventFullDetail | null>;
  patchEvent(input: PatchEventInput): Promise<PatchEventResult>;
  deleteEvent(calendarId: string, eventId: string, abortSignal?: AbortSignal): Promise<void>;
}

/**
 * イベントの「開始の瞬間」をAsia/Tokyoローカルの比較可能な文字列("YYYY-MM-DDTHH:mm:ss")へ変換する。
 * 終日予定はその開始日の00:00として扱う(過去日開始の複数日終日予定を「開始済み」として正しく除外するため)。
 * 変換できない場合はnull(呼び出し側でその項目自体を除外する)。
 */
function eventStartCompareValue(event: CalendarEventDetail): string | null {
  if (event.startDate !== null) {
    return `${event.startDate}T00:00:00`;
  }
  if (event.startDateTime !== null) {
    return toTokyoLocalFromIso(event.startDateTime);
  }
  return null;
}

export function createCalendarService(client: CalendarClient): CalendarService {
  return {
    async listEventsForRange({ calendarId, start, end }) {
      return client.listEvents({
        calendarId,
        timeMinIso: toRfc3339(start),
        timeMaxIso: toRfc3339(end),
        maxResults: DEFAULT_MAX_RESULTS,
      });
    },

    // 合計 DAY_EVENTS_MAX_TOTAL 件で打ち切る。1ページ目でその件数に達し、かつnextPageTokenが
    // 残っている場合のみ truncated:true とし、それ以上のページ取得は行わない。
    async listEventsDetailedForDayRange({ calendarId, start, end, abortSignal }) {
      const timeMinIso = toRfc3339(start);
      const timeMaxIso = toRfc3339(end);
      let events: CalendarEventDetail[] = [];
      let pageToken: string | undefined;
      let truncated = false;

      for (let page = 0; page < DAY_EVENTS_MAX_PAGES; page += 1) {
        const remaining = DAY_EVENTS_MAX_TOTAL - events.length;
        if (remaining <= 0) break;

        const pageResult = await client.listEventsDetailed({
          calendarId,
          timeMinIso,
          timeMaxIso,
          timeZone: TOKYO_ZONE,
          maxResults: remaining,
          ...(pageToken !== undefined ? { pageToken } : {}),
          ...(abortSignal !== undefined ? { abortSignal } : {}),
        });

        events = events.concat(pageResult.events);
        pageToken = pageResult.nextPageToken ?? undefined;

        if (pageToken === undefined) {
          break;
        }
        if (events.length >= DAY_EVENTS_MAX_TOTAL) {
          truncated = true;
          break;
        }
        if (page === DAY_EVENTS_MAX_PAGES - 1) {
          truncated = true;
        }
      }

      return { events: events.slice(0, DAY_EVENTS_MAX_TOTAL), truncated };
    },

    // timeMin/timeMaxはGoogle側の解釈を信用しない(timeMinは「終了時刻がtimeMinより後」の予定=進行中を
    // 含みうる)。開始の瞬間(全日予定は開始日00:00)が厳密に windowStart(now) より後、かつ
    // windowEnd(nowのカレンダー上2か月後、固定60日ではない)より前の予定だけをサーバー側で再判定して残す。
    // ページ内で先にlimitへ到達した場合、そのページに未消費の予定が残っていればtruncated:trueと確定できる。
    // ページちょうど末尾で到達した場合はnextPageTokenの有無で判定する。
    async listUpcomingEvents({ calendarId, now, limit, abortSignal }) {
      const windowStart = now;
      const windowEnd = now.plus({ months: 2 });
      const timeMinIso = toRfc3339(windowStart);
      const timeMaxIso = toRfc3339(windowEnd);
      const windowStartCompare = windowStart.setZone(TOKYO_ZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss");
      const windowEndCompare = windowEnd.setZone(TOKYO_ZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss");

      const collected: CalendarEventDetail[] = [];
      let pageToken: string | undefined;
      let truncated = false;

      for (let page = 0; page < UPCOMING_MAX_PAGES; page += 1) {
        const pageResult = await client.listEventsDetailed({
          calendarId,
          timeMinIso,
          timeMaxIso,
          timeZone: TOKYO_ZONE,
          maxResults: UPCOMING_PAGE_SIZE,
          ...(pageToken !== undefined ? { pageToken } : {}),
          ...(abortSignal !== undefined ? { abortSignal } : {}),
        });

        let filledMidPage = false;
        for (const event of pageResult.events) {
          if (collected.length >= limit) {
            filledMidPage = true;
            break;
          }
          const startCompare = eventStartCompareValue(event);
          if (startCompare !== null && startCompare > windowStartCompare && startCompare < windowEndCompare) {
            collected.push(event);
          }
        }

        if (filledMidPage) {
          truncated = true;
          break;
        }

        pageToken = pageResult.nextPageToken ?? undefined;

        if (collected.length >= limit) {
          truncated = pageToken !== undefined;
          break;
        }
        if (pageToken === undefined) {
          truncated = false;
          break;
        }
        if (page === UPCOMING_MAX_PAGES - 1) {
          truncated = true;
        }
      }

      return { events: collected.slice(0, limit), truncated };
    },

    async createEvent(input) {
      return client.insertEvent(input);
    },
    async getEvent(calendarId, eventId) {
      return client.getEvent(calendarId, eventId);
    },
    async getEventDetail(calendarId, eventId, abortSignal) {
      return client.getEventDetail(calendarId, eventId, abortSignal);
    },
    async patchEvent(input) {
      return client.patchEvent(input);
    },
    async deleteEvent(calendarId, eventId, abortSignal) {
      return client.deleteEvent(calendarId, eventId, abortSignal);
    },
  };
}
