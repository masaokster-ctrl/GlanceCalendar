import { describe, expect, it } from 'vitest';
import { generateUserCode, normalizeUserCodeInput } from '../src/product/userCode.js';

describe('generateUserCode', () => {
  it('returns an 8-character code formatted as XXXX-XXXX', () => {
    const code = generateUserCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('never includes visually confusable characters (0/O, 1/I, 8/B, 5/S, ...)', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateUserCode();
      const raw = code.replace('-', '');
      for (const bad of ['0', 'O', '1', 'I', '8', 'B', '5', 'S']) {
        expect(raw.includes(bad)).toBe(false);
      }
    }
  });

  it('produces different codes across calls (CSPRNG, not deterministic)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateUserCode()));
    expect(codes.size).toBeGreaterThan(40);
  });
});

describe('normalizeUserCodeInput', () => {
  it('uppercases lowercase input', () => {
    expect(normalizeUserCodeInput('abcd-efgh')).toBe('ABCDEFGH');
  });

  it('strips hyphens and whitespace', () => {
    expect(normalizeUserCodeInput('ABCD - EFGH')).toBe('ABCDEFGH');
  });

  it('strips any character outside A-Z0-9', () => {
    expect(normalizeUserCodeInput('AB!!CD@@12#$')).toBe('ABCD12');
  });

  it('returns an empty string for empty/whitespace-only input', () => {
    expect(normalizeUserCodeInput('')).toBe('');
    expect(normalizeUserCodeInput('   ')).toBe('');
  });
});
