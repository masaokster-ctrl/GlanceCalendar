import { DateTime } from 'luxon';
import type { Clock } from './clock.js';

export const TOKYO_ZONE = 'Asia/Tokyo';

export interface DateRange {
  start: DateTime;
  end: DateTime;
}

function nowInTokyo(clock: Clock): DateTime {
  return DateTime.fromJSDate(clock.now(), { zone: TOKYO_ZONE });
}

/** Asia/Tokyo基準の当日00:00〜翌日00:00 */
export function todayRangeTokyo(clock: Clock): DateRange {
  const start = nowInTokyo(clock).startOf('day');
  return { start, end: start.plus({ days: 1 }) };
}

/** Asia/Tokyo基準の翌日00:00〜翌々日00:00 */
export function tomorrowRangeTokyo(clock: Clock): DateRange {
  const start = nowInTokyo(clock).startOf('day').plus({ days: 1 });
  return { start, end: start.plus({ days: 1 }) };
}

/** Asia/Tokyo基準の明日15:00〜16:00（固定形式の予定作成用） */
export function tomorrowFixedEventRangeTokyo(clock: Clock): DateRange {
  const start = nowInTokyo(clock).startOf('day').plus({ days: 1, hours: 15 });
  return { start, end: start.plus({ hours: 1 }) };
}

/** Google Calendar APIへ渡すRFC3339形式（オフセット付き、Asia/Tokyo） */
export function toRfc3339(dt: DateTime): string {
  const iso = dt.setZone(TOKYO_ZONE).toISO({ suppressMilliseconds: true });
  if (!iso) {
    throw new Error('invalid DateTime: could not format as RFC3339');
  }
  return iso;
}

/** "YYYY-MM-DDTHH:mm:ss" 形式のAsia/Tokyoローカル時刻文字列(Gemini向けの基準時刻・比較用)。 */
export function nowLocalIsoTokyo(clock: Clock): string {
  return nowInTokyo(clock).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * 任意タイムゾーンのオフセット付きISO日時文字列(Google Calendar APIのevent.start/end.dateTime等)を
 * Asia/Tokyoのローカル日時文字列("YYYY-MM-DDTHH:mm:ss")へ変換する。不正な値はnullを返す。
 */
export function toTokyoLocalFromIso(iso: string): string | null {
  const dt = DateTime.fromISO(iso, { setZone: true }).setZone(TOKYO_ZONE);
  return dt.isValid ? dt.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}
