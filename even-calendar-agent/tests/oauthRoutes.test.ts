import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, TEST_SETUP_ADMIN_TOKEN, TEST_OAUTH_CONFIG, extractCookie } from './testHelpers.js';
import { SESSION_COOKIE_NAME } from '../src/auth/setupSession.js';
import { OAUTH_STATE_COOKIE_NAME } from '../src/auth/oauthState.js';
import { InMemoryRefreshTokenStore } from '../src/auth/refreshTokenStore.js';
import { createInMemoryOAuthVerificationTracker } from '../src/auth/oauthVerificationTracker.js';
import type { ExchangeAndVerifyFn } from '../src/routes/oauth.js';

async function loginAndGetSessionCookie(app: ReturnType<typeof createTestApp>): Promise<string> {
  const res = await request(app).post('/setup/login').type('form').send({ token: TEST_SETUP_ADMIN_TOKEN });
  const cookie = extractCookie(res.headers['set-cookie'], SESSION_COOKIE_NAME);
  if (!cookie) throw new Error('login failed in test setup');
  return cookie;
}

describe('GET /oauth2/start', () => {
  it('requires a valid setup session', async () => {
    const app = createTestApp();
    const res = await request(app).get('/oauth2/start');
    expect(res.status).toBe(401);
  });

  it('redirects to Google with the expected scope and offline/consent parameters, and sets a signed state cookie', async () => {
    const app = createTestApp();
    const sessionCookie = await loginAndGetSessionCookie(app);

    const res = await request(app).get('/oauth2/start').set('Cookie', sessionCookie).redirects(0);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('client_id')).toBe(TEST_OAUTH_CONFIG.clientId);
    expect(location.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events.owned');
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('include_granted_scopes')).toBe('true');
    expect(location.searchParams.get('prompt')).toBe('consent');
    expect(location.searchParams.get('state')).toBeTruthy();

    const stateCookie = extractCookie(res.headers['set-cookie'], OAUTH_STATE_COOKIE_NAME);
    expect(stateCookie).toBeDefined();
  });

  it('does not log the state value or the full authorization URL', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = createTestApp();
    const sessionCookie = await loginAndGetSessionCookie(app);

    const res = await request(app).get('/oauth2/start').set('Cookie', sessionCookie).redirects(0);
    const location = res.headers.location as string;
    const state = new URL(location).searchParams.get('state')!;

    const allText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allText).not.toContain(state);
    expect(allText).not.toContain(location);

    logSpy.mockRestore();
  });
});

describe('GET /oauth2/callback', () => {
  it('requires a valid setup session', async () => {
    const app = createTestApp();
    const res = await request(app).get('/oauth2/callback?code=abc&state=xyz');
    expect(res.status).toBe(401);
  });

  it('rejects when Google returns an error parameter', async () => {
    const app = createTestApp();
    const sessionCookie = await loginAndGetSessionCookie(app);
    const res = await request(app).get('/oauth2/callback?error=access_denied').set('Cookie', sessionCookie);
    expect(res.status).toBe(400);
  });

  it('rejects when the state does not match the cookie (CSRF protection)', async () => {
    const app = createTestApp();
    const sessionCookie = await loginAndGetSessionCookie(app);
    const startRes = await request(app).get('/oauth2/start').set('Cookie', sessionCookie).redirects(0);
    const stateCookie = extractCookie(startRes.headers['set-cookie'], OAUTH_STATE_COOKIE_NAME)!;

    const res = await request(app)
      .get('/oauth2/callback?code=abc&state=totally-different-state')
      .set('Cookie', [sessionCookie, stateCookie].join('; '));

    expect(res.status).toBe(400);
  });

  it('rejects when there is no code', async () => {
    const app = createTestApp();
    const sessionCookie = await loginAndGetSessionCookie(app);
    const startRes = await request(app).get('/oauth2/start').set('Cookie', sessionCookie).redirects(0);
    const stateCookie = extractCookie(startRes.headers['set-cookie'], OAUTH_STATE_COOKIE_NAME)!;
    const state = new URL(startRes.headers.location).searchParams.get('state')!;

    const res = await request(app)
      .get(`/oauth2/callback?state=${state}`)
      .set('Cookie', [sessionCookie, stateCookie].join('; '));

    expect(res.status).toBe(400);
  });

  it('saves the refresh token as a new secret version and records verification success', async () => {
    const refreshTokenStore = new InMemoryRefreshTokenStore();
    const verificationTracker = createInMemoryOAuthVerificationTracker();
    const exchangeAndVerifyFn: ExchangeAndVerifyFn = async () => ({ refreshToken: 'brand-new-refresh-token', verified: true });

    const app = createTestApp({ refreshTokenStore, verificationTracker, exchangeAndVerifyFn });
    const sessionCookie = await loginAndGetSessionCookie(app);
    const startRes = await request(app).get('/oauth2/start').set('Cookie', sessionCookie).redirects(0);
    const stateCookie = extractCookie(startRes.headers['set-cookie'], OAUTH_STATE_COOKIE_NAME)!;
    const state = new URL(startRes.headers.location).searchParams.get('state')!;

    const res = await request(app)
      .get(`/oauth2/callback?code=auth-code-123&state=${state}`)
      .set('Cookie', [sessionCookie, stateCookie].join('; '));

    expect(res.status).toBe(200);
    expect(await refreshTokenStore.getRefreshToken()).toBe('brand-new-refresh-token');
    expect(verificationTracker.getStatus().lastVerificationSucceeded).toBe(true);
    expect(res.text).not.toContain('brand-new-refresh-token');
    expect(res.text).not.toContain('auth-code-123');
  });

  it('does not overwrite the existing refresh token when none is returned', async () => {
    const refreshTokenStore = new InMemoryRefreshTokenStore();
    await refreshTokenStore.saveRefreshToken('existing-token');
    const exchangeAndVerifyFn: ExchangeAndVerifyFn = async () => ({ refreshToken: null, verified: true });

    const app = createTestApp({ refreshTokenStore, exchangeAndVerifyFn });
    const sessionCookie = await loginAndGetSessionCookie(app);
    const startRes = await request(app).get('/oauth2/start').set('Cookie', sessionCookie).redirects(0);
    const stateCookie = extractCookie(startRes.headers['set-cookie'], OAUTH_STATE_COOKIE_NAME)!;
    const state = new URL(startRes.headers.location).searchParams.get('state')!;

    await request(app)
      .get(`/oauth2/callback?code=auth-code-123&state=${state}`)
      .set('Cookie', [sessionCookie, stateCookie].join('; '));

    expect(await refreshTokenStore.getRefreshToken()).toBe('existing-token');
  });

  it('does not log the authorization code', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exchangeAndVerifyFn: ExchangeAndVerifyFn = async () => ({ refreshToken: 'token-x', verified: true });
    const app = createTestApp({ exchangeAndVerifyFn });
    const sessionCookie = await loginAndGetSessionCookie(app);
    const startRes = await request(app).get('/oauth2/start').set('Cookie', sessionCookie).redirects(0);
    const stateCookie = extractCookie(startRes.headers['set-cookie'], OAUTH_STATE_COOKIE_NAME)!;
    const state = new URL(startRes.headers.location).searchParams.get('state')!;

    await request(app)
      .get(`/oauth2/callback?code=super-secret-auth-code&state=${state}`)
      .set('Cookie', [sessionCookie, stateCookie].join('; '));

    const allText = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(allText).not.toContain('super-secret-auth-code');
    expect(allText).not.toContain('token-x');

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('GET /oauth2/status', () => {
  it('requires a valid setup session', async () => {
    const app = createTestApp();
    const res = await request(app).get('/oauth2/status');
    expect(res.status).toBe(401);
  });

  it('reports connected=false with no email address exposed when not connected', async () => {
    const app = createTestApp();
    const sessionCookie = await loginAndGetSessionCookie(app);
    const res = await request(app).get('/oauth2/status').set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connected: false,
      calendarApiVerificationSucceeded: null,
      lastVerifiedAt: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('email');
  });

  it('reports connected=true after a successful callback', async () => {
    const refreshTokenStore = new InMemoryRefreshTokenStore();
    const exchangeAndVerifyFn: ExchangeAndVerifyFn = async () => ({ refreshToken: 'token-y', verified: true });
    const app = createTestApp({ refreshTokenStore, exchangeAndVerifyFn });
    const sessionCookie = await loginAndGetSessionCookie(app);

    const startRes = await request(app).get('/oauth2/start').set('Cookie', sessionCookie).redirects(0);
    const stateCookie = extractCookie(startRes.headers['set-cookie'], OAUTH_STATE_COOKIE_NAME)!;
    const state = new URL(startRes.headers.location).searchParams.get('state')!;
    await request(app)
      .get(`/oauth2/callback?code=abc&state=${state}`)
      .set('Cookie', [sessionCookie, stateCookie].join('; '));

    const statusRes = await request(app).get('/oauth2/status').set('Cookie', sessionCookie);
    expect(statusRes.body.connected).toBe(true);
    expect(statusRes.body.calendarApiVerificationSucceeded).toBe(true);
    expect(typeof statusRes.body.lastVerifiedAt).toBe('string');
  });
});
