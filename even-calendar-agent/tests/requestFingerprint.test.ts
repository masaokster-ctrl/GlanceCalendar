import { describe, expect, it } from 'vitest';
import { computeRequestFingerprint } from '../src/utils/requestFingerprint.js';

describe('computeRequestFingerprint', () => {
  it('produces the same fingerprint for identical input', () => {
    const input = { model: 'even-ai', messageCount: 1, lastUserContent: '接続テスト、1回目です' };
    expect(computeRequestFingerprint(input)).toBe(computeRequestFingerprint(input));
  });

  it('produces a 64-character hex sha256 digest', () => {
    const fingerprint = computeRequestFingerprint({
      model: 'even-ai',
      messageCount: 1,
      lastUserContent: 'hello',
    });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when content differs', () => {
    const a = computeRequestFingerprint({ model: 'even-ai', messageCount: 1, lastUserContent: 'hello' });
    const b = computeRequestFingerprint({ model: 'even-ai', messageCount: 1, lastUserContent: 'world' });
    expect(a).not.toBe(b);
  });

  it('changes when model differs', () => {
    const a = computeRequestFingerprint({ model: 'model-a', messageCount: 1, lastUserContent: 'hello' });
    const b = computeRequestFingerprint({ model: 'model-b', messageCount: 1, lastUserContent: 'hello' });
    expect(a).not.toBe(b);
  });

  it('changes when messageCount differs', () => {
    const a = computeRequestFingerprint({ model: 'even-ai', messageCount: 1, lastUserContent: 'hello' });
    const b = computeRequestFingerprint({ model: 'even-ai', messageCount: 2, lastUserContent: 'hello' });
    expect(a).not.toBe(b);
  });

  it('normalizes non-string content safely without throwing', () => {
    expect(() =>
      computeRequestFingerprint({ model: 'even-ai', messageCount: 1, lastUserContent: [{ type: 'text', text: 'x' }] }),
    ).not.toThrow();
    expect(() =>
      computeRequestFingerprint({ model: 'even-ai', messageCount: 1, lastUserContent: undefined }),
    ).not.toThrow();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      computeRequestFingerprint({ model: 'even-ai', messageCount: 1, lastUserContent: circular }),
    ).not.toThrow();
  });

  it('never includes the raw content text in the output value itself beyond the digest', () => {
    const fingerprint = computeRequestFingerprint({
      model: 'even-ai',
      messageCount: 1,
      lastUserContent: 'a very private message',
    });
    expect(fingerprint).not.toContain('private');
  });
});
