import { Router, type Request, type Response } from 'express';
import { google } from 'googleapis';
import type { Clock } from '../time/clock.js';
import { readCookie } from '../security/cookies.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { logSanitizedError } from '../security/sanitizedError.js';
import { isValidSetupSession, SESSION_COOKIE_NAME } from '../auth/setupSession.js';
import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_MS,
  createOAuthStateCookieValue,
  generateOAuthState,
  verifyOAuthState,
} from '../auth/oauthState.js';
import {
  buildAuthorizationUrl,
  createOAuth2Client,
  exchangeCodeForTokens,
  type GoogleOAuthConfig,
} from '../auth/googleOAuthClient.js';
import type { RefreshTokenStore } from '../auth/refreshTokenStore.js';
import type { OAuthVerificationTracker } from '../auth/oauthVerificationTracker.js';
import { GoogleCalendarClient } from '../calendar/calendarClient.js';
import { createCalendarService } from '../calendar/calendarService.js';
import { todayRangeTokyo } from '../time/tokyoDateTime.js';

export interface ExchangeAndVerifyResult {
  refreshToken: string | null;
  verified: boolean;
}

export type ExchangeAndVerifyFn = (
  config: GoogleOAuthConfig,
  code: string,
  calendarId: string,
  clock: Clock,
) => Promise<ExchangeAndVerifyResult>;

/** 認可コードをトークンへ交換し、実Calendar APIで少数の予定を取得して認証有効性を検証する。 */
export async function defaultExchangeAndVerify(
  config: GoogleOAuthConfig,
  code: string,
  calendarId: string,
  clock: Clock,
): Promise<ExchangeAndVerifyResult> {
  const client = createOAuth2Client(config);
  const { refreshToken } = await exchangeCodeForTokens(client, code);

  let verified = false;
  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    const calendarService = createCalendarService(new GoogleCalendarClient(calendar));
    const { start, end } = todayRangeTokyo(clock);
    await calendarService.listEventsForRange({ calendarId, start, end });
    verified = true;
  } catch {
    verified = false;
  }

  return { refreshToken, verified };
}

export interface OAuthRouterDeps {
  setupAdminToken: string;
  oauthConfig: GoogleOAuthConfig;
  clock: Clock;
  refreshTokenStore: RefreshTokenStore;
  verificationTracker: OAuthVerificationTracker;
  calendarId: string;
  exchangeAndVerifyFn?: ExchangeAndVerifyFn;
}

function requireSetupSession(deps: OAuthRouterDeps, req: Request, res: Response): boolean {
  const sessionCookie = readCookie(req, SESSION_COOKIE_NAME);
  if (!isValidSetupSession(deps.setupAdminToken, sessionCookie, deps.clock)) {
    res.status(401).type('html').send('<p>管理ログインが必要です。<a href="/setup">/setup</a> からログインしてください。</p>');
    return false;
  }
  return true;
}

export function createOAuthRouter(deps: OAuthRouterDeps): Router {
  const exchangeAndVerify = deps.exchangeAndVerifyFn ?? defaultExchangeAndVerify;
  const router = Router();

  router.get('/oauth2/start', (req: Request, res: Response) => {
    if (!requireSetupSession(deps, req, res)) {
      return;
    }

    const state = generateOAuthState();
    const cookieValue = createOAuthStateCookieValue(deps.setupAdminToken, state, deps.clock);
    res.cookie(OAUTH_STATE_COOKIE_NAME, cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: OAUTH_STATE_TTL_MS,
    });

    const client = createOAuth2Client(deps.oauthConfig);
    const url = buildAuthorizationUrl(client, state);
    logSafeEvent({ event: 'oauth_start' });
    res.redirect(302, url);
  });

  router.get('/oauth2/callback', async (req: Request, res: Response) => {
    if (!requireSetupSession(deps, req, res)) {
      return;
    }

    const query = req.query as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code : null;
    const stateParam = typeof query.state === 'string' ? query.state : null;
    const errorParam = typeof query.error === 'string' ? query.error : null;

    const stateCookie = readCookie(req, OAUTH_STATE_COOKIE_NAME);
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/' });

    const stateValid = stateParam !== null && verifyOAuthState(deps.setupAdminToken, stateCookie, stateParam, deps.clock);

    if (errorParam || !code || !stateValid) {
      logSafeEvent({ event: 'oauth_callback_rejected' });
      res
        .status(400)
        .type('html')
        .send('<p>連携に失敗しました。もう一度 <a href="/oauth2/start">/oauth2/start</a> からやり直してください。</p>');
      return;
    }

    try {
      const { refreshToken, verified } = await exchangeAndVerify(deps.oauthConfig, code, deps.calendarId, deps.clock);

      if (refreshToken) {
        await deps.refreshTokenStore.saveRefreshToken(refreshToken);
      }

      if (verified) {
        deps.verificationTracker.recordSuccess(deps.clock.now());
        logSafeEvent({ event: 'oauth_callback_succeeded', oauthConnected: true });
        res.status(200).type('html').send('<p>Googleカレンダーとの連携が完了しました。<a href="/setup">/setup</a> へ戻る</p>');
      } else {
        deps.verificationTracker.recordFailure(deps.clock.now());
        logSafeEvent({ event: 'oauth_callback_verification_failed' });
        res
          .status(200)
          .type('html')
          .send('<p>連携情報を保存しましたが、Calendar APIの動作確認に失敗しました。<a href="/setup">/setup</a> へ戻る</p>');
      }
    } catch (err) {
      logSanitizedError('oauth_token_exchange_failed', err);
      res
        .status(400)
        .type('html')
        .send('<p>認可コードの交換に失敗しました。もう一度 <a href="/oauth2/start">/oauth2/start</a> からやり直してください。</p>');
    }
  });

  router.get('/oauth2/status', async (req: Request, res: Response) => {
    if (!requireSetupSession(deps, req, res)) {
      return;
    }

    const connected = (await deps.refreshTokenStore.getRefreshToken()) !== null;
    const status = deps.verificationTracker.getStatus();

    res.status(200).json({
      connected,
      calendarApiVerificationSucceeded: status.lastVerificationSucceeded,
      lastVerifiedAt: status.lastVerifiedAt ? status.lastVerifiedAt.toISOString() : null,
    });
  });

  return router;
}
