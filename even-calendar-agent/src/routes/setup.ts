import { Router, type Request, type Response } from 'express';
import type { Clock } from '../time/clock.js';
import { safeCompare } from '../security/timingSafe.js';
import { readCookie } from '../security/cookies.js';
import { logSafeEvent } from '../security/safeLogger.js';
import {
  createSetupSessionValue,
  isValidSetupSession,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from '../auth/setupSession.js';
import type { RefreshTokenStore } from '../auth/refreshTokenStore.js';

export interface SetupRouterDeps {
  setupAdminToken: string;
  clock: Clock;
  refreshTokenStore: RefreshTokenStore;
}

function renderLoginPage(errorMessage?: string): string {
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>Even Calendar Agent - Setup</title></head>
<body>
  <h1>管理ログイン</h1>
  ${errorMessage ? `<p style="color:red">${errorMessage}</p>` : ''}
  <form method="POST" action="/setup/login">
    <label>管理トークン: <input type="password" name="token" autocomplete="off" required /></label>
    <button type="submit">ログイン</button>
  </form>
</body>
</html>`;
}

function renderDashboardPage(connected: boolean): string {
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>Even Calendar Agent - Setup</title></head>
<body>
  <h1>Even Calendar Agent 管理画面</h1>
  <p>Google Calendar連携状態: ${connected ? '連携済み' : '未連携'}</p>
  <p><a href="/oauth2/start">Googleカレンダーと連携する</a></p>
  <p><a href="/oauth2/status">連携状態(JSON)を見る</a></p>
  <form method="POST" action="/setup/logout">
    <button type="submit">ログアウト</button>
  </form>
</body>
</html>`;
}

export function createSetupRouter(deps: SetupRouterDeps): Router {
  const router = Router();

  router.get('/setup', async (req: Request, res: Response) => {
    const sessionCookie = readCookie(req, SESSION_COOKIE_NAME);
    const validSession = isValidSetupSession(deps.setupAdminToken, sessionCookie, deps.clock);

    if (!validSession) {
      res.status(200).type('html').send(renderLoginPage());
      return;
    }

    const refreshToken = await deps.refreshTokenStore.getRefreshToken();
    res.status(200).type('html').send(renderDashboardPage(refreshToken !== null));
  });

  router.post('/setup/login', (req: Request, res: Response) => {
    const body = req.body as { token?: unknown } | undefined;
    const submitted = typeof body?.token === 'string' ? body.token : '';

    if (!submitted || !safeCompare(submitted, deps.setupAdminToken)) {
      logSafeEvent({ event: 'setup_login_failed' });
      res.status(401).type('html').send(renderLoginPage('トークンが正しくありません。'));
      return;
    }

    const sessionValue = createSetupSessionValue(deps.setupAdminToken, deps.clock);
    res.cookie(SESSION_COOKIE_NAME, sessionValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });

    logSafeEvent({ event: 'setup_login_succeeded' });
    res.redirect(303, '/setup');
  });

  router.post('/setup/logout', (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.redirect(303, '/setup');
  });

  return router;
}
