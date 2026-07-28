import { beforeEach, describe, expect, it } from 'vitest';
import { recordAndCountDuplicates, resetDuplicateTrackerForTests } from '../src/utils/duplicateTracker.js';

describe('recordAndCountDuplicates', () => {
  beforeEach(() => {
    resetDuplicateTrackerForTests();
  });

  it('returns 1 for the first occurrence', () => {
    expect(recordAndCountDuplicates('fp-a', 1_000)).toBe(1);
  });

  it('increments to 2 on the second occurrence within the window', () => {
    expect(recordAndCountDuplicates('fp-b', 1_000)).toBe(1);
    expect(recordAndCountDuplicates('fp-b', 1_500)).toBe(2);
  });

  it('increments to 3 on the third occurrence within the window', () => {
    recordAndCountDuplicates('fp-c', 1_000);
    recordAndCountDuplicates('fp-c', 1_500);
    expect(recordAndCountDuplicates('fp-c', 2_000)).toBe(3);
  });

  it('resets back to 1 after the 30 second window has elapsed since the last occurrence', () => {
    recordAndCountDuplicates('fp-d', 1_000);
    recordAndCountDuplicates('fp-d', 1_500);
    expect(recordAndCountDuplicates('fp-d', 1_500 + 30_001)).toBe(1);
  });

  it('tracks distinct fingerprints independently', () => {
    expect(recordAndCountDuplicates('fp-e', 1_000)).toBe(1);
    expect(recordAndCountDuplicates('fp-f', 1_000)).toBe(1);
  });
});
