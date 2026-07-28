import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../time/clock.js';
import { createSignedToken, verifySignedToken } from './signedToken.js';

export const OAUTH_STATE_COOKIE_NAME = 'even_oauth_state';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStatePayload {
  state: string;
  [key: string]: string | number;
}

export function generateOAuthState(): string {
  return randomBytes(32).toString('hex');
}

export function createOAuthStateCookieValue(secret: string, state: string, clock: Clock): string {
  const now = clock.now().getTime();
  const payload: OAuthStatePayload = { state };
  return createSignedToken(secret, payload, now + OAUTH_STATE_TTL_MS);
}

/** Cookieに保存された署名付きstateと、callbackで受け取ったstateクエリ値が完全一致するか検証する。 */
export function verifyOAuthState(
  secret: string,
  cookieValue: string | undefined,
  expectedState: string,
  clock: Clock,
): boolean {
  if (!cookieValue || !expectedState) {
    return false;
  }

  const payload = verifySignedToken<OAuthStatePayload>(secret, cookieValue, clock.now().getTime());
  if (!payload || typeof payload.state !== 'string') {
    return false;
  }

  const a = Buffer.from(payload.state);
  const b = Buffer.from(expectedState);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
