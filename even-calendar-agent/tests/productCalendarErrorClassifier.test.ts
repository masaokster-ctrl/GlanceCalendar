import { describe, expect, it } from 'vitest';
import { classifyProductCalendarError } from '../src/product/productCalendarErrorClassifier.js';

function gaxiosLikeError(status: number, data?: Record<string, unknown>): unknown {
  return { message: 'Request failed', response: { status, data } };
}

describe('classifyProductCalendarError', () => {
  it('classifies a token-endpoint error=invalid_client as product_google_refresh_invalid_client', () => {
    expect(classifyProductCalendarError(gaxiosLikeError(401, { error: 'invalid_client' }))).toBe('product_google_refresh_invalid_client');
  });

  it('classifies a token-endpoint error=invalid_grant as product_google_refresh_invalid_grant', () => {
    expect(classifyProductCalendarError(gaxiosLikeError(400, { error: 'invalid_grant' }))).toBe('product_google_refresh_invalid_grant');
  });

  it('classifies a token-endpoint error=unauthorized_client distinctly', () => {
    expect(classifyProductCalendarError(gaxiosLikeError(400, { error: 'unauthorized_client' }))).toBe('product_google_refresh_unauthorized_client');
  });

  it('classifies other known token-endpoint OAuth errors as product_google_refresh_invalid_grant', () => {
    expect(classifyProductCalendarError(gaxiosLikeError(400, { error: 'invalid_scope' }))).toBe('product_google_refresh_invalid_grant');
  });

  it('classifies a bare HTTP 401 with no token-endpoint error field as product_google_refresh_invalid_client (matches the real incident signature)', () => {
    expect(classifyProductCalendarError(gaxiosLikeError(401))).toBe('product_google_refresh_invalid_client');
  });

  it('classifies HTTP 403 (no token-endpoint error field) as product_calendar_forbidden (insufficient scope/permission)', () => {
    expect(classifyProductCalendarError(gaxiosLikeError(403, { error: { code: 403, message: 'Insufficient Permission' } }))).toBe('product_calendar_forbidden');
  });

  it('classifies HTTP 429 as product_calendar_quota', () => {
    expect(classifyProductCalendarError(gaxiosLikeError(429))).toBe('product_calendar_quota');
  });

  it('classifies HTTP 5xx as product_calendar_provider_unavailable', () => {
    expect(classifyProductCalendarError(gaxiosLikeError(500))).toBe('product_calendar_provider_unavailable');
    expect(classifyProductCalendarError(gaxiosLikeError(503))).toBe('product_calendar_provider_unavailable');
  });

  it('classifies other 4xx (no recognized enum) as product_calendar_invalid_response', () => {
    expect(classifyProductCalendarError(gaxiosLikeError(404))).toBe('product_calendar_invalid_response');
  });

  it('classifies network-level system error codes as product_calendar_provider_unavailable', () => {
    expect(classifyProductCalendarError({ code: 'ETIMEDOUT' })).toBe('product_calendar_provider_unavailable');
    expect(classifyProductCalendarError({ code: 'ECONNRESET' })).toBe('product_calendar_provider_unavailable');
  });

  it('classifies a non-object/unrecognized value as product_calendar_unknown', () => {
    expect(classifyProductCalendarError('a string')).toBe('product_calendar_unknown');
    expect(classifyProductCalendarError(null)).toBe('product_calendar_unknown');
    expect(classifyProductCalendarError(undefined)).toBe('product_calendar_unknown');
  });

  it('never requires or reflects Calendar API error message text in its output (enum values only)', () => {
    const result = classifyProductCalendarError(gaxiosLikeError(403, { error: { code: 403, message: 'SENSITIVE_DETAIL_TEXT', errors: [] } }));
    expect(result).toBe('product_calendar_forbidden');
    expect(String(result)).not.toContain('SENSITIVE_DETAIL_TEXT');
  });
});
