import { toTokyoLocalFromIso } from '../time/tokyoDateTime.js';
import type { SupportedLocale } from '../i18n/locale.js';
import type { CalendarEventDetail, CalendarEventFullDetail } from './calendarClient.js';

const MAX_TITLE_LENGTH = 80;
const MAX_LOCATION_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
/** 表示専用フォールバック。Calendarへの書き戻しやユーザー入力の置き換えには絶対に使わない。 */
const UNTITLED: Record<SupportedLocale, string> = {
  ja: '名称未設定',
  en: 'Untitled',
};
const CONTROL_CHAR_CODE_MAX = 0x1f;
const DEL_CHAR_CODE = 0x7f;

/**
 * /plugin/calendar-events/day と /plugin/calendar-events/upcoming で共通のイベント表示形。
 * eventIdは/plugin/calendar-events/:eventIdでの詳細取得・更新・削除に使う実際のGoogle event ID。
 * description・location・attendees等の内容フィールドはここには一切含まない。
 */
export interface EventResponseItem {
  eventId: string;
  title: string;
  allDay: boolean;
  startLocal?: string;
  endLocal?: string;
  startDate?: string;
  endDateExclusive?: string;
}

export interface AttendeeResponseItem {
  email: string;
  displayName?: string;
  responseStatus?: string;
}

/**
 * /plugin/calendar-events/:eventId (GET) の1件詳細形。空/未設定のフィールドはプレースホルダーを
 * 出さずキー自体を省略する(製品仕様: 値がない項目は表示しない)。
 */
export interface EventDetailResponseItem {
  eventId: string;
  title: string;
  status: string;
  allDay: boolean;
  startLocal?: string;
  endLocal?: string;
  startDate?: string;
  endDateExclusive?: string;
  location?: string;
  description?: string;
  attendees?: AttendeeResponseItem[];
  meetingUrl?: string;
  etag?: string;
}

function stripControlChars(raw: string): string {
  let stripped = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    stripped += code <= CONTROL_CHAR_CODE_MAX || code === DEL_CHAR_CODE ? ' ' : ch;
  }
  return stripped
    .split(' ')
    .filter((part) => part.length > 0)
    .join(' ')
    .trim();
}

/** 制御文字・改行を除去し、空/未設定は locale 別の「名称未設定」/「Untitled」、最大80文字に丸める。 */
export function sanitizeTitle(raw: string | null, locale: SupportedLocale = 'ja'): string {
  if (raw === null) return UNTITLED[locale];
  const stripped = stripControlChars(raw);
  if (stripped.length === 0) return UNTITLED[locale];
  return stripped.length > MAX_TITLE_LENGTH ? stripped.slice(0, MAX_TITLE_LENGTH) : stripped;
}

/** location/description用: 制御文字を除去し、空/未設定はundefined(=省略)、maxLengthで丸める。 */
function sanitizeOptionalText(raw: string | null, maxLength: number): string | undefined {
  if (raw === null) return undefined;
  const stripped = stripControlChars(raw);
  if (stripped.length === 0) return undefined;
  return stripped.length > maxLength ? stripped.slice(0, maxLength) : stripped;
}

/**
 * 終日予定はstartDate/endDateExclusive(Google側と同じ、終了日は排他的)、時間指定予定は
 * startLocal/endLocal(Asia/Tokyoローカル、実際の開始/終了。日境界へのクリップはしない)を返す。
 * 変換に失敗した場合はその項目のみ該当フィールドを省略する(タイトルは表示できる)。
 */
export function toEventResponseItem(detail: CalendarEventDetail, locale: SupportedLocale = 'ja'): EventResponseItem {
  const title = sanitizeTitle(detail.summary, locale);

  if (detail.startDate !== null) {
    return {
      eventId: detail.eventId,
      title,
      allDay: true,
      startDate: detail.startDate,
      endDateExclusive: detail.endDate ?? detail.startDate,
    };
  }

  const startLocal = detail.startDateTime !== null ? toTokyoLocalFromIso(detail.startDateTime) : null;
  const endLocal = detail.endDateTime !== null ? toTokyoLocalFromIso(detail.endDateTime) : null;

  return {
    eventId: detail.eventId,
    title,
    allDay: false,
    ...(startLocal !== null ? { startLocal } : {}),
    ...(endLocal !== null ? { endLocal } : {}),
  };
}

/** /plugin/calendar-events/:eventId (GET) 用。値のないフィールドは省略する(空文字/nullを返さない)。 */
export function toEventDetailResponseItem(detail: CalendarEventFullDetail, locale: SupportedLocale = 'ja'): EventDetailResponseItem {
  const title = sanitizeTitle(detail.summary, locale);
  const timing =
    detail.startDate !== null
      ? { allDay: true as const, startDate: detail.startDate, endDateExclusive: detail.endDate ?? detail.startDate }
      : (() => {
          const startLocal = detail.startDateTime !== null ? toTokyoLocalFromIso(detail.startDateTime) : null;
          const endLocal = detail.endDateTime !== null ? toTokyoLocalFromIso(detail.endDateTime) : null;
          return {
            allDay: false as const,
            ...(startLocal !== null ? { startLocal } : {}),
            ...(endLocal !== null ? { endLocal } : {}),
          };
        })();

  const location = sanitizeOptionalText(detail.location, MAX_LOCATION_LENGTH);
  const description = sanitizeOptionalText(detail.description, MAX_DESCRIPTION_LENGTH);
  const attendees =
    detail.attendees && detail.attendees.length > 0
      ? detail.attendees.map((a) => ({
          email: a.email,
          ...(a.displayName !== null ? { displayName: a.displayName } : {}),
          ...(a.responseStatus !== null ? { responseStatus: a.responseStatus } : {}),
        }))
      : undefined;

  return {
    eventId: detail.eventId,
    title,
    status: detail.status,
    ...timing,
    ...(location !== undefined ? { location } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(attendees !== undefined ? { attendees } : {}),
    ...(detail.conferenceJoinUrl !== null ? { meetingUrl: detail.conferenceJoinUrl } : {}),
    ...(detail.etag !== null ? { etag: detail.etag } : {}),
  };
}
