import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { buildSafeRequestMetadata } from '../src/utils/safeRequestMetadata.js';

function fakeRequest(options: {
  headers?: Record<string, string>;
  body?: unknown;
  method?: string;
  path?: string;
}): Request {
  const headers = options.headers ?? {};
  return {
    method: options.method ?? 'POST',
    path: options.path ?? '/v1/chat/completions',
    header: (name: string) => headers[name.toLowerCase()],
    body: options.body,
  } as unknown as Request;
}

describe('buildSafeRequestMetadata', () => {
  it('never includes the raw message content or Authorization header value', () => {
    const req = fakeRequest({
      headers: {
        authorization: 'Bearer super-secret-token',
        'content-type': 'application/json',
        'user-agent': 'test-agent/1.0',
      },
      body: {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'this is a private conversation' }],
        stream: false,
        extra_field: 'unexpected-value',
      },
    });

    const metadata = buildSafeRequestMetadata(req, 123);
    const serialized = JSON.stringify(metadata);

    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('this is a private conversation');
    expect(serialized).not.toContain('unexpected-value');

    expect(metadata.hasAuthorizationHeader).toBe(true);
    expect(metadata.isBearerScheme).toBe(true);
    expect(metadata.hasModel).toBe(true);
    expect(metadata.hasMessages).toBe(true);
    expect(metadata.messageCount).toBe(1);
    expect(metadata.messageRoles).toEqual(['user']);
    expect(metadata.contentTypes).toEqual(['string']);
    expect(metadata.hasUserField).toBe(false);
    expect(metadata.unknownFields).toEqual(['extra_field']);
    expect(metadata.fieldTypes.extra_field).toBe('string');
    expect(metadata.userAgent).toBe('test-agent/1.0');
    expect(metadata.bodyByteLength).toBe(123);
  });

  it('reports absence of Authorization header safely', () => {
    const req = fakeRequest({ body: {} });
    const metadata = buildSafeRequestMetadata(req, 0);

    expect(metadata.hasAuthorizationHeader).toBe(false);
    expect(metadata.isBearerScheme).toBe(false);
    expect(metadata.topLevelFields).toEqual([]);
    expect(metadata.messageCount).toBeNull();
  });

  it('handles non-array messages and non-object bodies without throwing', () => {
    const req = fakeRequest({ body: { messages: 'not-an-array' } });
    const metadata = buildSafeRequestMetadata(req, 10);

    expect(metadata.hasMessages).toBe(true);
    expect(metadata.messageCount).toBeNull();
    expect(metadata.messageRoles).toEqual([]);
  });
});
