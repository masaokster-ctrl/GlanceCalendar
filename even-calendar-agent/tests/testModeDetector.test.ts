import { describe, expect, it } from 'vitest';
import { detectTestMode } from '../src/utils/testModeDetector.js';

describe('detectTestMode', () => {
  it('returns default for non-string content', () => {
    expect(detectTestMode(undefined)).toBe('default');
    expect(detectTestMode(null)).toBe('default');
    expect(detectTestMode(123)).toBe('default');
    expect(detectTestMode([{ type: 'text', text: '遅延テスト1秒' }])).toBe('default');
  });

  it('returns default for ordinary conversation containing numbers', () => {
    expect(detectTestMode('今日は3時に会議です')).toBe('default');
    expect(detectTestMode('1秒だけ待って')).toBe('default');
    expect(detectTestMode('明日の予定を教えて')).toBe('default');
  });

  it.each([
    ['遅延テスト1秒', 'delay-1s'],
    ['遅延テスト一秒', 'delay-1s'],
    ['1秒遅延テスト', 'delay-1s'],
    ['一秒遅延テスト', 'delay-1s'],
    ['遅延テスト3秒', 'delay-3s'],
    ['遅延テスト三秒', 'delay-3s'],
    ['3秒遅延テスト', 'delay-3s'],
    ['三秒遅延テスト', 'delay-3s'],
    ['遅延テスト5秒', 'delay-5s'],
    ['遅延テスト五秒', 'delay-5s'],
    ['5秒遅延テスト', 'delay-5s'],
    ['五秒遅延テスト', 'delay-5s'],
    ['遅延テスト10秒', 'delay-10s'],
    ['遅延テスト十秒', 'delay-10s'],
    ['10秒遅延テスト', 'delay-10s'],
    ['十秒遅延テスト', 'delay-10s'],
    ['表示長テスト', 'display-length'],
    ['表示の長さテスト', 'display-length'],
    ['表示文字数テスト', 'display-length'],
  ] as const)('recognizes %s as %s', (phrase, expected) => {
    expect(detectTestMode(phrase)).toBe(expected);
  });

  it('tolerates leading/trailing whitespace and punctuation', () => {
    expect(detectTestMode('  遅延テスト3秒  ')).toBe('delay-3s');
    expect(detectTestMode('遅延テスト5秒。')).toBe('delay-5s');
    expect(detectTestMode('遅延テスト10秒！')).toBe('delay-10s');
    expect(detectTestMode('　表示長テスト　')).toBe('display-length');
  });

  it('does not match partial or embedded phrases', () => {
    expect(detectTestMode('明日は遅延テスト3秒をやります')).toBe('default');
    expect(detectTestMode('遅延テスト3秒お願いします')).toBe('default');
  });
});
