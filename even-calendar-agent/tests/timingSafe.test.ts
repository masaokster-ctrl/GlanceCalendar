import { describe, expect, it } from 'vitest';
import { safeCompare } from '../src/security/timingSafe.js';

describe('safeCompare', () => {
  it('returns true for identical strings', () => {
    expect(safeCompare('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(safeCompare('abc123', 'abc124')).toBe(false);
  });

  it('returns false for strings of different lengths without throwing', () => {
    expect(safeCompare('short', 'a-much-longer-string')).toBe(false);
  });

  it('returns false when comparing against an empty string', () => {
    expect(safeCompare('abc123', '')).toBe(false);
  });
});
