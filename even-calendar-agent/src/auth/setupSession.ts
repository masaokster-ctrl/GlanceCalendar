import type { Clock } from '../time/clock.js';
import { createSignedToken, verifySignedToken } from './signedToken.js';

export const SESSION_COOKIE_NAME = 'even_setup_session';
export const SESSION_TTL_MS = 30 * 60 * 1000;

interface SessionPayload {
  purpose: 'setup-session';
  [key: string]: string | number;
}

/** SETUP_ADMIN_TOKENを署名鍵として使う、HMAC署名付きの短時間ステートレスセッション値を生成する。 */
export function createSetupSessionValue(adminTokenSecret: string, clock: Clock): string {
  const now = clock.now().getTime();
  const payload: SessionPayload = { purpose: 'setup-session' };
  return createSignedToken(adminTokenSecret, payload, now + SESSION_TTL_MS);
}

export function isValidSetupSession(adminTokenSecret: string, cookieValue: string | undefined, clock: Clock): boolean {
  if (!cookieValue) {
    return false;
  }
  const payload = verifySignedToken<SessionPayload>(adminTokenSecret, cookieValue, clock.now().getTime());
  return payload !== null && payload.purpose === 'setup-session';
}
