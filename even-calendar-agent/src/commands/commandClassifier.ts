import { normalizeUtterance } from './textNormalize.js';
import { isFixedEventCreateUtterance } from './fixedEventParser.js';
import { classifyConfirmation } from './confirmationParser.js';

export type CommandType =
  | 'today-list'
  | 'tomorrow-list'
  | 'create-fixed-event'
  | 'confirm-yes'
  | 'confirm-no'
  | 'unsupported';

const TODAY_PHRASES = new Set([
  '今日の予定を教えて',
  '今日のスケジュールを教えて',
  // Even AI標準機能との競合を避けるための、独自Agent専用の別名コマンド。
  // 「今日」単体では一致しないよう、必ず「エージェント」/「マイエージェント」を含む形のみ登録する。
  'エージェント今日',
  'マイエージェント今日',
  'エージェント今日を確認',
  // Even AI組み込みの意図判定(天気機能など)との競合を避けるための番号コマンド。
  // 「今日」「明日」「予定」「カレンダー」を含まない、「接続テスト」+番号の組み合わせでのみ判定する。
  '接続テスト一',
  '接続テスト1',
  '接続テストいち',
]);
const TOMORROW_PHRASES = new Set([
  '明日の予定を教えて',
  '明日のスケジュールを教えて',
  'エージェント明日',
  'マイエージェント明日',
  'エージェント明日を確認',
  '接続テスト二',
  '接続テスト2',
  '接続テストに',
]);

/**
 * 決定的なルールで発話を分類する(Geminiは使わない)。
 * ルーティング優先順: 今日 → 明日 → 固定予定作成 → 肯定/否定 → 対応外。
 */
export function classifyCommand(content: unknown): CommandType {
  if (typeof content !== 'string') {
    return 'unsupported';
  }

  const normalized = normalizeUtterance(content);

  if (TODAY_PHRASES.has(normalized)) {
    return 'today-list';
  }
  if (TOMORROW_PHRASES.has(normalized)) {
    return 'tomorrow-list';
  }
  if (isFixedEventCreateUtterance(content)) {
    return 'create-fixed-event';
  }

  const confirmation = classifyConfirmation(content);
  if (confirmation === 'yes') {
    return 'confirm-yes';
  }
  if (confirmation === 'no') {
    return 'confirm-no';
  }

  return 'unsupported';
}
