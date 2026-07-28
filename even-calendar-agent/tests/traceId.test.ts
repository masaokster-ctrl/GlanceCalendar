import { describe, expect, it } from 'vitest';
import { extractTraceId } from '../src/utils/traceId.js';

describe('extractTraceId', () => {
  it('extracts the trace id before the slash', () => {
    expect(extractTraceId('105445aa7843bc8bf206b12000100000/1;o=1')).toBe('105445aa7843bc8bf206b12000100000');
  });

  it('returns the whole header when there is no slash', () => {
    expect(extractTraceId('just-an-id')).toBe('just-an-id');
  });

  it('returns null when header is absent', () => {
    expect(extractTraceId(undefined)).toBeNull();
    expect(extractTraceId(null)).toBeNull();
    expect(extractTraceId('')).toBeNull();
  });
});
