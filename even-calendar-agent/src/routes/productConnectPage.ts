import { Router, type Request, type Response } from 'express';
import type { Clock } from '../time/clock.js';
import { readCookie } from '../security/cookies.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { hashValue } from '../security/devSessionToken.js';
import { normalizeUserCodeInput } from '../product/userCode.js';
import type { PluginRateLimitRepository } from '../firestore/pluginRateLimitRepository.js';
import type { ProductPairingRepository } from '../product/productPairingRepository.js';
import type { ProductSigningKeyProvider } from '../product/productSigningKey.js';
import {
  BROWSER_PAIRING_SESSION_COOKIE_NAME,
  BROWSER_PAIRING_SESSION_TTL_MS,
  createBrowserPairingSessionCookieValue,
  CSRF_TOKEN_COOKIE_NAME,
  CSRF_TOKEN_TTL_MS,
  createCsrfToken,
  verifyCsrfToken,
} from '../product/productBrowserCookies.js';

const MAX_VERIFY_ATTEMPTS_PER_PAIRING = 5;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;

export interface ProductConnectPageRouterDeps {
  clock: Clock;
  rateLimitRepo: PluginRateLimitRepository;
  pairingRepo: ProductPairingRepository;
  signingKeyProvider: ProductSigningKeyProvider;
  rateLimitPerMinute?: number;
}

function securityHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Frame-Options', 'DENY');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_STYLE = `body{font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#222}
h1{font-size:20px}p{font-size:14px;color:#555;line-height:1.5}
input[type=text]{font-size:20px;letter-spacing:2px;text-align:center;width:100%;padding:12px;box-sizing:border-box;margin:12px 0}
button{font-size:16px;padding:12px;width:100%;box-sizing:border-box}
.button-link{display:block;font-size:16px;padding:12px;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;color:#222;background:#f0f0f0;border:1px solid #ccc;border-radius:4px}
.error{color:#b00020}.privacy{font-size:12px;color:#777}`;

function renderConnectForm(csrfToken: string, errorMessage: string | null): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calendar with Gemini - 接続</title><style>${PAGE_STYLE}</style></head><body>
<h1>Calendar with Gemini</h1>
<p>Even G2に表示されているペアリングコードを入力してください。</p>
${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ''}
<form method="post" action="/connect/verify">
<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
<input type="text" name="userCode" placeholder="ABCD-EFGH" maxlength="9" autocomplete="off" required>
<button type="submit">次へ</button>
</form>
<p class="privacy">音声・文字起こし・カレンダーの予定内容はこのページでは保存・送信されません。接続にはGoogleアカウントでのログインとCalendarへのアクセス許可が必要です。</p>
</body></html>`;
}

function renderOAuthStartPage(): string {
  // 「Googleで接続」はform submitではなく通常のリンク(<a>)にすること。
  // /product/oauth/google/start はGoogle認可URLへ302 redirectするため、form submitのままだと
  // ブラウザがform-action 'self' CSPをredirect先(cross-origin)にも適用してブロックしてしまう
  // (CSP3のform-actionはナビゲーション全体のredirect chainに適用される)。
  // <a>タグのナビゲーションはform-actionの対象外のため、CSPを緩めずに解決できる。
  // JavaScript/onclickは使わず、相対URLのみ、userCode/pairingId/state/tokenはURLへ含めない
  // (認可対象はHttpOnly/Secure/SameSiteのbrowser pairing session cookieで特定される)。
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calendar with Gemini - 接続</title><style>${PAGE_STYLE}</style></head><body>
<h1>Calendar with Gemini</h1>
<p>コードを確認しました。続けてGoogleアカウントで接続してください。</p>
<a class="button-link" href="/product/oauth/google/start">Googleで接続</a>
<p class="privacy">音声・文字起こし・カレンダーの予定内容はこのページでは保存・送信されません。</p>
</body></html>`;
}

function renderErrorPage(message: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calendar with Gemini - エラー</title><style>${PAGE_STYLE}</style></head><body>
<h1>Calendar with Gemini</h1>
<p class="error">${escapeHtml(message)}</p>
<form method="get" action="/connect"><button type="submit">やり直す</button></form>
</body></html>`;
}

function renderNotConfiguredPage(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Calendar with Gemini</title></head><body><p>現在この機能は準備中です。しばらくしてから再度お試しください。</p></body></html>`;
}

export function createProductConnectPageRouter(deps: ProductConnectPageRouterDeps): Router {
  const router = Router();
  const rateLimitPerMinute = deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;

  async function rateLimited(bucketPrefix: string, key: string): Promise<boolean> {
    const now = deps.clock.now();
    const result = await deps.rateLimitRepo.consume({ sessionKey: `${bucketPrefix}:${key}`, now, limit: rateLimitPerMinute });
    return !result.allowed;
  }

  router.get('/connect', (req: Request, res: Response) => {
    securityHeaders(res);
    if (!deps.signingKeyProvider.available) {
      res.status(503).type('html').send(renderNotConfiguredPage());
      return;
    }
    let csrfToken = readCookie(req, CSRF_TOKEN_COOKIE_NAME);
    if (!csrfToken) {
      csrfToken = createCsrfToken(deps.signingKeyProvider, deps.clock);
      res.cookie(CSRF_TOKEN_COOKIE_NAME, csrfToken, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: CSRF_TOKEN_TTL_MS });
    }
    res.status(200).type('html').send(renderConnectForm(csrfToken, null));
  });

  router.post('/connect/verify', async (req: Request, res: Response) => {
    securityHeaders(res);

    if (!deps.signingKeyProvider.available) {
      res.status(503).type('html').send(renderNotConfiguredPage());
      return;
    }

    const ipHash = hashValue(req.ip ?? 'unknown');
    if (await rateLimited('connect-verify-ip', ipHash)) {
      res.status(429).type('html').send(renderErrorPage('アクセスが集中しています。少し待って再度お試しください。'));
      return;
    }

    const body = req.body as { csrfToken?: unknown; userCode?: unknown } | undefined;
    const csrfCookie = readCookie(req, CSRF_TOKEN_COOKIE_NAME);
    const csrfBody = typeof body?.csrfToken === 'string' ? body.csrfToken : '';

    if (!verifyCsrfToken(deps.signingKeyProvider, csrfCookie, csrfBody, deps.clock)) {
      logSafeEvent({ event: 'product_connect_verify_csrf_rejected' });
      res.status(400).type('html').send(renderErrorPage('セッションの有効期限が切れました。もう一度 /connect からやり直してください。'));
      return;
    }

    const rawCode = typeof body?.userCode === 'string' ? body.userCode : '';
    const normalizedCode = normalizeUserCodeInput(rawCode);
    if (normalizedCode.length === 0) {
      res.status(400).type('html').send(renderErrorPage('コードを入力してください。'));
      return;
    }

    const codeHash = hashValue(normalizedCode);
    if (await rateLimited('connect-verify-code', codeHash)) {
      res.status(429).type('html').send(renderErrorPage('アクセスが集中しています。少し待って再度お試しください。'));
      return;
    }

    const now = deps.clock.now();
    const pairing = await deps.pairingRepo.findPendingByUserCodeHash(codeHash, now);

    // generic error(enumeration防止): コード不明/期限切れ/試行回数超過はすべて同一メッセージ
    const genericInvalid = (): void => {
      logSafeEvent({ event: 'product_connect_verify_failed' });
      res.status(400).type('html').send(renderErrorPage('コードが正しくないか、有効期限が切れています。'));
    };

    if (!pairing) {
      genericInvalid();
      return;
    }

    if (pairing.attemptCount >= MAX_VERIFY_ATTEMPTS_PER_PAIRING) {
      genericInvalid();
      return;
    }

    await deps.pairingRepo.recordPollAttempt(pairing.pairingId, now);

    logSafeEvent({ event: 'product_pairing_verified' });

    const sessionCookieValue = createBrowserPairingSessionCookieValue(deps.signingKeyProvider, pairing.pairingId, deps.clock);
    res.cookie(BROWSER_PAIRING_SESSION_COOKIE_NAME, sessionCookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: BROWSER_PAIRING_SESSION_TTL_MS,
    });
    res.clearCookie(CSRF_TOKEN_COOKIE_NAME, { path: '/' });

    res.status(200).type('html').send(renderOAuthStartPage());
  });

  return router;
}
