import { describe, expect, it } from 'vitest';
import { classifyProductOAuthTokenError } from '../src/product/productOAuthErrorClassifier.js';

function gaxiosLikeError(status: number, data?: Record<string, unknown>): unknown {
  return { message: 'Request failed', response: { status, data } };
}

describe('classifyProductOAuthTokenError', () => {
  it('classifies HTTP 401 as invalid_client (client authentication failure)', () => {
    expect(classifyProductOAuthTokenError(gaxiosLikeError(401))).toBe('invalid_client');
  });

  it('classifies HTTP 400 with no parseable body as invalid_grant', () => {
    expect(classifyProductOAuthTokenError(gaxiosLikeError(400))).toBe('invalid_grant');
  });

  it('prefers Google\'s explicit error field over the HTTP status when both are present', () => {
    expect(classifyProductOAuthTokenError(gaxiosLikeError(400, { error: 'invalid_client' }))).toBe('invalid_client');
    expect(classifyProductOAuthTokenError(gaxiosLikeError(401, { error: 'invalid_grant' }))).toBe('invalid_grant');
  });

  it('classifies Google error=unauthorized_client distinctly', () => {
    expect(classifyProductOAuthTokenError(gaxiosLikeError(400, { error: 'unauthorized_client' }))).toBe('unauthorized_client');
  });

  it('classifies other known Google OAuth errors (invalid_request/unsupported_grant_type/invalid_scope) as invalid_request', () => {
    expect(classifyProductOAuthTokenError(gaxiosLikeError(400, { error: 'invalid_request' }))).toBe('invalid_request');
    expect(classifyProductOAuthTokenError(gaxiosLikeError(400, { error: 'unsupported_grant_type' }))).toBe('invalid_request');
    expect(classifyProductOAuthTokenError(gaxiosLikeError(400, { error: 'invalid_scope' }))).toBe('invalid_request');
  });

  it('classifies HTTP 5xx as provider_unavailable', () => {
    expect(classifyProductOAuthTokenError(gaxiosLikeError(500))).toBe('provider_unavailable');
    expect(classifyProductOAuthTokenError(gaxiosLikeError(503))).toBe('provider_unavailable');
  });

  it('classifies network-level system error codes as provider_unavailable', () => {
    expect(classifyProductOAuthTokenError({ code: 'ETIMEDOUT' })).toBe('provider_unavailable');
    expect(classifyProductOAuthTokenError({ code: 'ECONNRESET' })).toBe('provider_unavailable');
    expect(classifyProductOAuthTokenError({ code: 'ECONNREFUSED' })).toBe('provider_unavailable');
    expect(classifyProductOAuthTokenError({ code: 'ENOTFOUND' })).toBe('provider_unavailable');
  });

  it('classifies a plain Error with no HTTP response shape as token_response_invalid', () => {
    expect(classifyProductOAuthTokenError(new Error('id_token verification failed'))).toBe('token_response_invalid');
  });

  it('classifies a non-object/unrecognized value as unknown', () => {
    expect(classifyProductOAuthTokenError('a string')).toBe('unknown');
    expect(classifyProductOAuthTokenError(null)).toBe('unknown');
    expect(classifyProductOAuthTokenError(undefined)).toBe('unknown');
  });

  it('never requires or reflects error_description in its output (enum values only)', () => {
    const result = classifyProductOAuthTokenError(gaxiosLikeError(400, { error: 'invalid_grant', error_description: 'SENSITIVE_DETAIL_TEXT' }));
    expect(result).toBe('invalid_grant');
    expect(String(result)).not.toContain('SENSITIVE_DETAIL_TEXT');
  });
});
