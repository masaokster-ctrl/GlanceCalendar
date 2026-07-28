import { Router, type Request, type Response } from 'express';
import type { Clock } from '../time/clock.js';
import { readCookie } from '../security/cookies.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { hashValue, shortHashPrefix } from '../security/devSessionToken.js';
import { createOAuth2Client, type GoogleOAuthConfig } from '../auth/googleOAuthClient.js';
import { buildProductAuthorizationUrl, defaultProductExchange, type ProductExchangeFn } from '../product/productGoogleOAuthClient.js';
import {
  BROWSER_PAIRING_SESSION_COOKIE_NAME,
  PRODUCT_OAUTH_STATE_COOKIE_NAME,
  PRODUCT_OAUTH_STATE_TTL_MS,
  createProductOAuthStateCookieValue,
  generateNonce,
  generateOAuthState,
  verifyBrowserPairingSessionCookie,
  verifyProductOAuthState,
} from '../product/productBrowserCookies.js';
import type { ProductSigningKeyProvider } from '../product/productSigningKey.js';
import type { ProductPairingRepository } from '../product/productPairingRepository.js';
import type { ProductUserRepository } from '../product/productUserRepository.js';
import type { GoogleCredentialRepository } from '../product/productGoogleCredentialRepository.js';
import { EncryptionNotConfiguredError } from '../product/googleCredentialCipher.js';
import { PRODUCT_OAUTH_SCOPES } from '../product/productOAuthConfig.js';
import { classifyProductOAuthTokenError } from '../product/productOAuthErrorClassifier.js';

export interface ProductOAuthRouterDeps {
  clock: Clock;
  /** devの oauthConfig とは完全に分離された、製品用のGoogle OAuth client(未設定ならnull→503)。 */
  productOAuthConfig: GoogleOAuthConfig | null;
  signingKeyProvider: ProductSigningKeyProvider;
  pairingRepo: ProductPairingRepository;
  userRepo: ProductUserRepository;
  credentialRepo: GoogleCredentialRepository;
  exchangeFn?: ProductExchangeFn;
}

function errorPage(res: Response, status: number, message: string): void {
  res.status(status).type('html').send(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Calendar with Gemini</title></head><body><p>${message}</p><p><a href="/connect">/connect からやり直してください</a></p></body></html>`,
  );
}

function successPage(res: Response): void {
  res
    .status(200)
    .type('html')
    .send(
      '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Calendar with Gemini</title></head><body><h1>接続しました</h1><p>Even G2をご確認ください。このページは閉じて構いません。</p></body></html>',
    );
}

export function createProductOAuthRouter(deps: ProductOAuthRouterDeps): Router {
  const router = Router();
  const exchangeFn = deps.exchangeFn ?? defaultProductExchange;

  function notConfigured(res: Response, message: string): void {
    res.status(503).type('html').send(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Calendar with Gemini</title></head><body><p>${message}</p></body></html>`,
    );
  }

  router.get('/product/oauth/google/start', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    if (!deps.productOAuthConfig) {
      notConfigured(res, '現在この機能は準備中です。しばらくしてから再度お試しください。');
      return;
    }
    if (!deps.signingKeyProvider.available) {
      notConfigured(res, '現在この機能は準備中です。しばらくしてから再度お試しください。');
      return;
    }
    const productOAuthConfig = deps.productOAuthConfig;

    const sessionCookie = readCookie(req, BROWSER_PAIRING_SESSION_COOKIE_NAME);
    const pairingId = verifyBrowserPairingSessionCookie(deps.signingKeyProvider, sessionCookie, deps.clock);
    if (!pairingId) {
      errorPage(res, 401, 'ブラウザのペアリングセッションが無効です。');
      return;
    }

    const now = deps.clock.now();
    const pairing = await deps.pairingRepo.getById(pairingId);
    if (!pairing || pairing.expiresAt.getTime() <= now.getTime() || (pairing.status !== 'pending' && pairing.status !== 'oauth_in_progress')) {
      errorPage(res, 400, 'ペアリングの有効期限が切れているか、既に処理されています。');
      return;
    }

    const client = createOAuth2Client(productOAuthConfig);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    if (!codeChallenge) {
      errorPage(res, 500, 'PKCEの生成に失敗しました。');
      return;
    }
    const state = generateOAuthState();
    const nonce = generateNonce();

    const cookieValue = createProductOAuthStateCookieValue(deps.signingKeyProvider, { state, pairingId, codeVerifier, nonce }, deps.clock);
    res.cookie(PRODUCT_OAUTH_STATE_COOKIE_NAME, cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: PRODUCT_OAUTH_STATE_TTL_MS,
    });

    await deps.pairingRepo.markOAuthInProgress(pairingId);
    logSafeEvent({ event: 'product_oauth_started' });

    const url = buildProductAuthorizationUrl(client, { state, codeChallenge, nonce });
    res.redirect(302, url);
  });

  router.get('/product/oauth/google/callback', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    if (!deps.productOAuthConfig) {
      notConfigured(res, '現在この機能は準備中です。しばらくしてから再度お試しください。');
      return;
    }
    if (!deps.signingKeyProvider.available) {
      notConfigured(res, '現在この機能は準備中です。しばらくしてから再度お試しください。');
      return;
    }
    const productOAuthConfig = deps.productOAuthConfig;

    const query = req.query as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code : null;
    const stateParam = typeof query.state === 'string' ? query.state : null;
    const errorParam = typeof query.error === 'string' ? query.error : null;

    const stateCookie = readCookie(req, PRODUCT_OAUTH_STATE_COOKIE_NAME);
    res.clearCookie(PRODUCT_OAUTH_STATE_COOKIE_NAME, { path: '/' });

    const statePayload = stateParam !== null ? verifyProductOAuthState(deps.signingKeyProvider, stateCookie, stateParam, deps.clock) : null;

    if (errorParam || !code || !statePayload) {
      // state/PKCE検証やGoogle側errorパラメータによる失敗はtoken交換失敗とは別の事象として記録する
      // (token_exchange_failedへは決して混在させない)。
      logSafeEvent({ event: 'product_oauth_callback_rejected', sanitizedErrorCode: 'product_oauth_state_failed' });
      errorPage(res, 400, '接続に失敗しました。');
      return;
    }

    const { pairingId, codeVerifier } = statePayload;
    const now = deps.clock.now();
    const pairing = await deps.pairingRepo.getById(pairingId);
    if (!pairing || pairing.expiresAt.getTime() <= now.getTime() || pairing.status !== 'oauth_in_progress') {
      errorPage(res, 400, 'ペアリングの有効期限が切れているか、既に処理されています。');
      return;
    }

    let exchangeResult: Awaited<ReturnType<ProductExchangeFn>>;
    try {
      exchangeResult = await exchangeFn(productOAuthConfig, code, codeVerifier);
    } catch (err) {
      // error_description・レスポンス本文・トークン等は一切ログへ出さない。
      // Googleの標準化されたerror enum(またはHTTP status由来の推定)のみを分類・記録する。
      const providerError = classifyProductOAuthTokenError(err);
      const sanitizedErrorCode = `product_oauth_${providerError}`;
      logSafeEvent({ event: 'product_oauth_token_exchange_failed', level: 'error', sanitizedErrorCode });
      await deps.pairingRepo.markFailed(pairingId, sanitizedErrorCode, now);
      errorPage(res, 400, '認可コードの交換に失敗しました。');
      return;
    }

    if (!exchangeResult.googleSubject) {
      await deps.pairingRepo.markFailed(pairingId, 'oauth_identity_failed', now);
      errorPage(res, 400, 'Googleアカウントの確認に失敗しました。');
      return;
    }

    const googleSubjectHash = hashValue(exchangeResult.googleSubject);
    let user = await deps.userRepo.findBySubjectHash(googleSubjectHash);
    if (!user) {
      user = await deps.userRepo.create({ googleSubjectHash, googleEmailHash: null, now });
    } else {
      await deps.userRepo.touchLogin(user.userId, now);
    }

    if (exchangeResult.refreshToken) {
      try {
        await deps.credentialRepo.saveForUser({
          userId: user.userId,
          refreshToken: exchangeResult.refreshToken,
          grantedScopes: [...PRODUCT_OAUTH_SCOPES],
          now,
        });
      } catch (err) {
        if (err instanceof EncryptionNotConfiguredError) {
          await deps.pairingRepo.markFailed(pairingId, 'product_oauth_encryption_not_configured', now);
          res.status(503).type('html').send(
            '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Calendar with Gemini</title></head><body><p>現在この機能は準備中です。しばらくしてから再度お試しください。</p></body></html>',
          );
          return;
        }
        // KMS呼び出し自体の失敗(権限・ネットワーク等)。生のエラー内容はログへ出さず、
        // pairingをapprovedにはせずgeneric errorとして扱う(平文fallbackは行わない)。
        logSafeEvent({ event: 'product_oauth_credential_save_failed', level: 'error', sanitizedErrorCode: 'product_oauth_kms_failed' });
        await deps.pairingRepo.markFailed(pairingId, 'product_oauth_kms_failed', now);
        errorPage(res, 400, 'Google認証情報の保存に失敗しました。もう一度お試しください。');
        return;
      }
    } else {
      // refresh tokenが返らなかった場合、既存credentialがなければ失敗として扱う(平文fallbackはしない)。
      const existing = await deps.credentialRepo.getForUser(user.userId).catch(() => null);
      if (!existing) {
        await deps.pairingRepo.markFailed(pairingId, 'oauth_no_refresh_token', now);
        errorPage(res, 400, 'Googleカレンダーへのアクセス許可を取得できませんでした。もう一度お試しください。');
        return;
      }
      // 既存credentialは変更しない(消さない)。
    }

    await deps.pairingRepo.markApproved(pairingId, user.userId, now);
    logSafeEvent({ event: 'product_oauth_completed', installIdHashPrefix: shortHashPrefix(pairing.installationIdHash) });

    successPage(res);
  });

  return router;
}
