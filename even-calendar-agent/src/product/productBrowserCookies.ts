import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../time/clock.js';
import { createSignedToken, verifySignedToken } from '../auth/signedToken.js';
import type { ProductSigningKeyProvider } from './productSigningKey.js';

// setupAdminTokenの流用は廃止(フェーズ2I)。専用のPRODUCT_BROWSER_SIGNING_KEYから
// 用途別subkey(browser-session-v1 / csrf-v1 / oauth-state-v1)をHKDFで導出して使う。

export const BROWSER_PAIRING_SESSION_COOKIE_NAME = 'even_pairing_session';
export const BROWSER_PAIRING_SESSION_TTL_MS = 10 * 60 * 1000;

interface BrowserPairingSessionPayload {
  pairingId: string;
  [key: string]: string | number;
}

/** /connect/verify成功後に発行する、ブラウザ側の短期ペアリングセッション(pairingIdのみを保持、userCodeは含めない)。 */
export function createBrowserPairingSessionCookieValue(signingKeyProvider: ProductSigningKeyProvider, pairingId: string, clock: Clock): string {
  return createSignedToken(signingKeyProvider.subkey('browser-session-v1'), { pairingId }, clock.now().getTime() + BROWSER_PAIRING_SESSION_TTL_MS);
}

export function verifyBrowserPairingSessionCookie(
  signingKeyProvider: ProductSigningKeyProvider,
  cookieValue: string | undefined,
  clock: Clock,
): string | null {
  if (!cookieValue) return null;
  const payload = verifySignedToken<BrowserPairingSessionPayload>(
    signingKeyProvider.subkey('browser-session-v1'),
    cookieValue,
    clock.now().getTime(),
  );
  if (!payload || typeof payload.pairingId !== 'string') return null;
  return payload.pairingId;
}

export const PRODUCT_OAUTH_STATE_COOKIE_NAME = 'even_product_oauth_state';
export const PRODUCT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface ProductOAuthStateParams {
  state: string;
  pairingId: string;
  codeVerifier: string;
  nonce: string;
  [key: string]: string | number;
}

type ProductOAuthStatePayload = ProductOAuthStateParams;

export function generateOAuthState(): string {
  return randomBytes(32).toString('hex');
}

export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

export function createProductOAuthStateCookieValue(signingKeyProvider: ProductSigningKeyProvider, params: ProductOAuthStateParams, clock: Clock): string {
  return createSignedToken(signingKeyProvider.subkey('oauth-state-v1'), params, clock.now().getTime() + PRODUCT_OAUTH_STATE_TTL_MS);
}

/**
 * state(timing-safe比較)・pairingId・PKCE用codeVerifier・nonceを一括で検証・取得する。
 * どれか一つでも欠けている/stateが不一致ならnull。
 */
export function verifyProductOAuthState(
  signingKeyProvider: ProductSigningKeyProvider,
  cookieValue: string | undefined,
  expectedState: string,
  clock: Clock,
): ProductOAuthStateParams | null {
  if (!cookieValue || !expectedState) return null;
  const payload = verifySignedToken<ProductOAuthStatePayload>(signingKeyProvider.subkey('oauth-state-v1'), cookieValue, clock.now().getTime());
  if (!payload) return null;
  if (typeof payload.state !== 'string' || typeof payload.pairingId !== 'string') return null;
  if (typeof payload.codeVerifier !== 'string' || typeof payload.nonce !== 'string') return null;

  const a = Buffer.from(payload.state);
  const b = Buffer.from(expectedState);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return { state: payload.state, pairingId: payload.pairingId, codeVerifier: payload.codeVerifier, nonce: payload.nonce };
}

export const CSRF_TOKEN_COOKIE_NAME = 'even_connect_csrf';
export const CSRF_TOKEN_TTL_MS = 10 * 60 * 1000;

interface CsrfTokenPayload {
  nonce: string;
  [key: string]: string | number;
}

/** connect pageのdouble-submit CSRF token。csrf-v1 subkeyで署名し、cookie Max-Ageとは独立に期限切れを検証する。 */
export function createCsrfToken(signingKeyProvider: ProductSigningKeyProvider, clock: Clock): string {
  const nonce = randomBytes(16).toString('hex');
  return createSignedToken(signingKeyProvider.subkey('csrf-v1'), { nonce }, clock.now().getTime() + CSRF_TOKEN_TTL_MS);
}

/** cookie値とform送信値がbyte-for-byte一致(timing-safe)し、かつ署名・期限が有効な場合のみtrue。 */
export function verifyCsrfToken(
  signingKeyProvider: ProductSigningKeyProvider,
  cookieValue: string | undefined,
  submittedValue: string,
  clock: Clock,
): boolean {
  if (!cookieValue || submittedValue.length === 0) return false;
  if (cookieValue.length !== submittedValue.length) return false;
  if (!timingSafeEqual(Buffer.from(cookieValue), Buffer.from(submittedValue))) return false;

  const payload = verifySignedToken<CsrfTokenPayload>(signingKeyProvider.subkey('csrf-v1'), cookieValue, clock.now().getTime());
  return payload !== null && typeof payload.nonce === 'string';
}
