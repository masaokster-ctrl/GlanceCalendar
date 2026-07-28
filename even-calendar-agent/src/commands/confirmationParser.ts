import { normalizeUtterance } from './textNormalize.js';

export type Confirmation = 'yes' | 'no' | 'none';

const YES_PHRASES = new Set(['はい', '登録して', '確定', 'お願いします', 'それで登録して']);
const NO_PHRASES = new Set(['いいえ', 'やめて', 'キャンセル', '登録しない']);

export function classifyConfirmation(content: unknown): Confirmation {
  if (typeof content !== 'string') {
    return 'none';
  }

  const normalized = normalizeUtterance(content);
  if (YES_PHRASES.has(normalized)) {
    return 'yes';
  }
  if (NO_PHRASES.has(normalized)) {
    return 'no';
  }
  return 'none';
}
