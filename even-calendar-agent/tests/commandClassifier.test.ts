import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../src/commands/commandClassifier.js';

describe('classifyCommand', () => {
  it.each(['今日の予定を教えて', '今日のスケジュールを教えて'])('classifies "%s" as today-list', (phrase) => {
    expect(classifyCommand(phrase)).toBe('today-list');
  });

  it.each(['明日の予定を教えて', '明日のスケジュールを教えて'])('classifies "%s" as tomorrow-list', (phrase) => {
    expect(classifyCommand(phrase)).toBe('tomorrow-list');
  });

  it.each([
    'エージェント、今日',
    'エージェント今日',
    'マイエージェント、今日',
    'マイエージェント今日',
    'エージェント今日を確認',
    'エージェント、今日を確認',
    '  エージェント今日  ',
    'エージェント、今日。',
  ])('classifies "%s" as today-list (agent alias)', (phrase) => {
    expect(classifyCommand(phrase)).toBe('today-list');
  });

  it.each([
    'エージェント、明日',
    'エージェント明日',
    'マイエージェント、明日',
    'マイエージェント明日',
    'エージェント明日を確認',
    'エージェント、明日を確認',
  ])('classifies "%s" as tomorrow-list (agent alias)', (phrase) => {
    expect(classifyCommand(phrase)).toBe('tomorrow-list');
  });

  it.each(['エージェント、テスト登録', 'エージェントテスト登録', 'マイエージェント、テスト登録', 'マイエージェントテスト登録'])(
    'classifies "%s" as create-fixed-event (agent alias)',
    (phrase) => {
      expect(classifyCommand(phrase)).toBe('create-fixed-event');
    },
  );

  it.each(['接続テスト一', '接続テスト1', '接続テスト、1', '接続テスト、いち', '接続テストいち'])(
    'classifies "%s" as today-list (numbered command)',
    (phrase) => {
      expect(classifyCommand(phrase)).toBe('today-list');
    },
  );

  it.each(['接続テスト二', '接続テスト2', '接続テスト、2', '接続テスト、に', '接続テストに'])(
    'classifies "%s" as tomorrow-list (numbered command)',
    (phrase) => {
      expect(classifyCommand(phrase)).toBe('tomorrow-list');
    },
  );

  it.each(['接続テスト三', '接続テスト3', '接続テスト、3', '接続テスト、さん', '接続テストさん'])(
    'classifies "%s" as create-fixed-event (numbered command)',
    (phrase) => {
      expect(classifyCommand(phrase)).toBe('create-fixed-event');
    },
  );

  it('does not classify a bare number or kanji numeral as a command', () => {
    expect(classifyCommand('1')).toBe('unsupported');
    expect(classifyCommand('一')).toBe('unsupported');
    expect(classifyCommand('今日は1件あります')).toBe('unsupported');
  });

  it('does not classify unrelated phrases containing "接続" or "テスト" as a numbered command', () => {
    expect(classifyCommand('接続をテストしてください')).toBe('unsupported');
    expect(classifyCommand('テストは1回です')).toBe('unsupported');
    expect(classifyCommand('接続テスト')).toBe('unsupported');
  });

  it('does not treat bare 今日/明日 as the agent alias command', () => {
    expect(classifyCommand('今日')).toBe('unsupported');
    expect(classifyCommand('明日')).toBe('unsupported');
    expect(classifyCommand('今日を確認')).toBe('unsupported');
  });

  it('does not misinterpret ordinary conversation mentioning "エージェント"', () => {
    expect(classifyCommand('エージェントってすごいね')).toBe('unsupported');
    expect(classifyCommand('今日はエージェントの話をしました')).toBe('unsupported');
  });

  it.each([
    '明日の15時に接続テスト予定を作って',
    '明日15時に接続テスト予定を入れて',
    '明日の午後3時に接続テスト予定を作って',
  ])('classifies "%s" as create-fixed-event', (phrase) => {
    expect(classifyCommand(phrase)).toBe('create-fixed-event');
  });

  it.each(['はい', '登録して', '確定', 'お願いします', 'それで登録して'])('classifies "%s" as confirm-yes', (phrase) => {
    expect(classifyCommand(phrase)).toBe('confirm-yes');
  });

  it.each(['いいえ', 'やめて', 'キャンセル', '登録しない'])('classifies "%s" as confirm-no', (phrase) => {
    expect(classifyCommand(phrase)).toBe('confirm-no');
  });

  it('does not misclassify ordinary conversation as a calendar command', () => {
    expect(classifyCommand('こんにちは')).toBe('unsupported');
    expect(classifyCommand('今日はいい天気ですね')).toBe('unsupported');
    expect(classifyCommand('明日は忙しいです')).toBe('unsupported');
    expect(classifyCommand('遅延テスト1秒')).toBe('unsupported');
  });

  it('does not throw and returns unsupported for non-string content', () => {
    expect(classifyCommand(undefined)).toBe('unsupported');
    expect(classifyCommand(null)).toBe('unsupported');
    expect(classifyCommand(42)).toBe('unsupported');
    expect(classifyCommand([{ type: 'text', text: '今日の予定を教えて' }])).toBe('unsupported');
    expect(classifyCommand({ foo: 'bar' })).toBe('unsupported');
  });
});
