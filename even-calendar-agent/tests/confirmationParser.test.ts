import { describe, expect, it } from 'vitest';
import { classifyConfirmation } from '../src/commands/confirmationParser.js';

describe('classifyConfirmation', () => {
  it.each(['はい', '登録して', '確定', 'お願いします', 'それで登録して'])('classifies "%s" as yes', (phrase) => {
    expect(classifyConfirmation(phrase)).toBe('yes');
  });

  it.each(['いいえ', 'やめて', 'キャンセル', '登録しない'])('classifies "%s" as no', (phrase) => {
    expect(classifyConfirmation(phrase)).toBe('no');
  });

  it('returns none for unrelated content', () => {
    expect(classifyConfirmation('こんにちは')).toBe('none');
    expect(classifyConfirmation(undefined)).toBe('none');
    expect(classifyConfirmation(123)).toBe('none');
  });
});
