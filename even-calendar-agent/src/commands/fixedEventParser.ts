import type { Clock } from '../time/clock.js';
import { toRfc3339, tomorrowFixedEventRangeTokyo, TOKYO_ZONE } from '../time/tokyoDateTime.js';
import { normalizeUtterance, convertAfternoonHour } from './textNormalize.js';

const FIXED_EVENT_SUMMARY = '接続テスト予定';
const FIXED_EVENT_DESCRIPTION = 'Even G2から登録';

// 「午後3時」は正規化後にconvertAfternoonHourで「15時」へ変換されるため、
// 変換後の正準形はこの2パターンのみになる。
// 「エージェントテスト登録」系はEven AI標準機能との競合を避けるための独自Agent専用の別名コマンド。
// 「接続テスト三」系はEven AI組み込みの意図判定(天気機能など)との競合を避けるための番号コマンド。
const CANONICAL_PHRASES_AFTER_CONVERSION = new Set([
  '明日の15時に接続テスト予定を作って',
  '明日15時に接続テスト予定を入れて',
  'エージェントテスト登録',
  'マイエージェントテスト登録',
  '接続テスト三',
  '接続テスト3',
  '接続テストさん',
]);

export function isFixedEventCreateUtterance(content: unknown): boolean {
  if (typeof content !== 'string') {
    return false;
  }
  const normalized = convertAfternoonHour(normalizeUtterance(content));
  return CANONICAL_PHRASES_AFTER_CONVERSION.has(normalized);
}

export interface FixedEventDefinition {
  calendarId: string;
  summary: string;
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
  description: string;
}

/** 固定形式のテスト予定(明日15:00〜16:00「接続テスト予定」)を生成する。 */
export function buildFixedEventDefinition(clock: Clock, calendarId: string): FixedEventDefinition {
  const { start, end } = tomorrowFixedEventRangeTokyo(clock);
  return {
    calendarId,
    summary: FIXED_EVENT_SUMMARY,
    startDateTime: toRfc3339(start),
    endDateTime: toRfc3339(end),
    timeZone: TOKYO_ZONE,
    description: FIXED_EVENT_DESCRIPTION,
  };
}
