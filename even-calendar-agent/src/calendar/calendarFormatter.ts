import { DateTime } from 'luxon';
import { TOKYO_ZONE } from '../time/tokyoDateTime.js';
import type { CalendarEventSummary } from './calendarClient.js';

// G2は表示領域が限られるため、一度に読み上げ/表示する予定件数を制限する。
const MAX_DISPLAY_ITEMS = 5;

function formatSingleEvent(event: CalendarEventSummary): string {
  const title = event.summary && event.summary.trim().length > 0 ? event.summary : 'タイトルなし';

  if (event.startDateTime) {
    const dt = DateTime.fromISO(event.startDateTime).setZone(TOKYO_ZONE);
    const timeLabel = dt.minute === 0 ? `${dt.hour}時` : `${dt.hour}時${String(dt.minute).padStart(2, '0')}分`;
    return `${timeLabel} ${title}`;
  }

  if (event.startDate) {
    return `終日 ${title}`;
  }

  return title;
}

/** 予定一覧を短い日本語のテキストへ整形する。canceledは呼び出し側で除外済みであること。 */
export function formatEventListForSpeech(events: CalendarEventSummary[], emptyMessage: string): string {
  const visible = events.filter((event) => event.status !== 'cancelled');

  if (visible.length === 0) {
    return emptyMessage;
  }

  const limited = visible.slice(0, MAX_DISPLAY_ITEMS);
  const lines = limited.map(formatSingleEvent);
  const remaining = visible.length - limited.length;

  if (remaining > 0) {
    lines.push(`ほか${remaining}件あります`);
  }

  return lines.join('\n');
}
