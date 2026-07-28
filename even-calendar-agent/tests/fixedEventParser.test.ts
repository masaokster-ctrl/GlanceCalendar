import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/time/clock.js';
import { buildFixedEventDefinition, isFixedEventCreateUtterance } from '../src/commands/fixedEventParser.js';

describe('isFixedEventCreateUtterance', () => {
  it('recognizes the three specified phrases', () => {
    expect(isFixedEventCreateUtterance('明日の15時に接続テスト予定を作って')).toBe(true);
    expect(isFixedEventCreateUtterance('明日15時に接続テスト予定を入れて')).toBe(true);
    expect(isFixedEventCreateUtterance('明日の午後3時に接続テスト予定を作って')).toBe(true);
  });

  it('recognizes the agent alias phrases', () => {
    expect(isFixedEventCreateUtterance('エージェント、テスト登録')).toBe(true);
    expect(isFixedEventCreateUtterance('エージェントテスト登録')).toBe(true);
    expect(isFixedEventCreateUtterance('マイエージェント、テスト登録')).toBe(true);
    expect(isFixedEventCreateUtterance('マイエージェントテスト登録')).toBe(true);
  });

  it('recognizes the numbered command phrases', () => {
    expect(isFixedEventCreateUtterance('接続テスト三')).toBe(true);
    expect(isFixedEventCreateUtterance('接続テスト3')).toBe(true);
    expect(isFixedEventCreateUtterance('接続テスト、3')).toBe(true);
    expect(isFixedEventCreateUtterance('接続テスト、さん')).toBe(true);
    expect(isFixedEventCreateUtterance('接続テストさん')).toBe(true);
  });

  it('rejects unrelated event-creation requests', () => {
    expect(isFixedEventCreateUtterance('明日の16時に接続テスト予定を作って')).toBe(false);
    expect(isFixedEventCreateUtterance('明日の15時に打ち合わせを作って')).toBe(false);
    expect(isFixedEventCreateUtterance('来週の15時に接続テスト予定を作って')).toBe(false);
  });

  it('returns false for non-string content without throwing', () => {
    expect(isFixedEventCreateUtterance(undefined)).toBe(false);
    expect(isFixedEventCreateUtterance([{ type: 'text', text: '明日の15時に接続テスト予定を作って' }])).toBe(false);
  });
});

describe('buildFixedEventDefinition', () => {
  it('generates tomorrow 15:00-16:00 JST with the expected fixed content', () => {
    const clock = fixedClock('2026-07-21T01:00:00.000Z');
    const def = buildFixedEventDefinition(clock, 'primary');

    expect(def.summary).toBe('接続テスト予定');
    expect(def.description).toBe('Even G2から登録');
    expect(def.timeZone).toBe('Asia/Tokyo');
    expect(def.calendarId).toBe('primary');
    expect(def.startDateTime).toBe('2026-07-22T15:00:00+09:00');
    expect(def.endDateTime).toBe('2026-07-22T16:00:00+09:00');
  });

  it('does not depend on the real current time', () => {
    const a = buildFixedEventDefinition(fixedClock('2020-05-05T00:00:00.000Z'), 'primary');
    const b = buildFixedEventDefinition(fixedClock('2020-05-05T00:00:00.000Z'), 'primary');
    expect(a.startDateTime).toBe(b.startDateTime);
  });
});
