import { describe, expect, it } from 'vitest';
import { createSignedToken, verifySignedToken } from '../src/auth/signedToken.js';

describe('signedToken', () => {
  it('verifies a token signed with the same secret', () => {
    const token = createSignedToken('secret-a', { foo: 'bar' }, Date.now() + 60_000);
    const payload = verifySignedToken('secret-a', token, Date.now());
    expect(payload?.foo).toBe('bar');
  });

  it('rejects a token verified with a different secret', () => {
    const token = createSignedToken('secret-a', { foo: 'bar' }, Date.now() + 60_000);
    expect(verifySignedToken('secret-b', token, Date.now())).toBeNull();
  });

  it('rejects an expired token', () => {
    const now = Date.now();
    const token = createSignedToken('secret-a', { foo: 'bar' }, now - 1000);
    expect(verifySignedToken('secret-a', token, now)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = createSignedToken('secret-a', { foo: 'bar' }, Date.now() + 60_000);
    const [body, signature] = token.split('.');
    const tamperedBody = Buffer.from(JSON.stringify({ foo: 'tampered', exp: Date.now() + 60_000 })).toString(
      'base64url',
    );
    const tampered = `${tamperedBody}.${signature}`;
    expect(verifySignedToken('secret-a', tampered, Date.now())).toBeNull();
    void body;
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifySignedToken('secret-a', 'not-a-token', Date.now())).toBeNull();
    expect(verifySignedToken('secret-a', '', Date.now())).toBeNull();
    expect(verifySignedToken('secret-a', 'a.b.c', Date.now())).toBeNull();
  });
});
