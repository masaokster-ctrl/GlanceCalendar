import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, extractCookie, TEST_OAUTH_CONFIG, TEST_PRODUCT_OAUTH_CONFIG } from './testHelpers.js';
import { InMemoryProductPairingRepository } from '../src/product/productPairingRepository.js';
import { InMemoryProductUserRepository } from '../src/product/productUserRepository.js';
import { InMemoryGoogleCredentialRepository } from '../src/product/productGoogleCredentialRepository.js';
import { FakeGoogleCredentialCipher } from '../src/product/googleCredentialCipher.js';
import { InMemoryPluginRateLimitRepository } from '../src/firestore/pluginRateLimitRepository.js';
import { hashValue } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';
import { ProductSigningKeyProvider } from '../src/product/productSigningKey.js';
import type { ProductExchangeFn } from '../src/product/productGoogleOAuthClient.js';

const NOW = new Date('2026-07-23T05:00:00Z');
const INSTALL_HASH = 'install-hash-1';
const USER_CODE = 'ABCD-EFGH';

function fakeExchange(result: { refreshToken: string | null; googleSubject: string | null } = { refreshToken: 'rt-1', googleSubject: 'google-sub-1' }) {
  const calls: { code: string; codeVerifier: string; clientId: string; clientSecret: string; redirectUri: string }[] = [];
  const fn: ProductExchangeFn = async (config, code, codeVerifier) => {
    calls.push({ code, codeVerifier, clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri });
    return result;
  };
  return { fn, calls };
}

function throwingExchange(err: unknown): ProductExchangeFn {
  return async () => {
    throw err;
  };
}

function setup(opts: { exchangeFn?: ProductExchangeFn; useFakeCipher?: boolean } = {}) {
  const productPairingRepo = new InMemoryProductPairingRepository();
  const productUserRepo = new InMemoryProductUserRepository();
  const productCredentialCipher = opts.useFakeCipher === false ? undefined : new FakeGoogleCredentialCipher();
  const productCredentialRepo = productCredentialCipher ? new InMemoryGoogleCredentialRepository(productCredentialCipher) : undefined;
  const pluginRateLimitRepo = new InMemoryPluginRateLimitRepository();
  const app = createTestApp({
    clock: fixedClock(NOW),
    productPairingRepo,
    productUserRepo,
    pluginRateLimitRepo,
    ...(productCredentialRepo ? { productCredentialRepo } : {}),
    ...(opts.exchangeFn ? { productExchangeFn: opts.exchangeFn } : {}),
  });
  return { app, productPairingRepo, productUserRepo, productCredentialRepo };
}

async function createPendingPairing(productPairingRepo: InMemoryProductPairingRepository) {
  const pairingId = 'pairing-1';
  await productPairingRepo.create({
    pairingId,
    userCodeHash: hashValue(USER_CODE.replace('-', '')),
    installationIdHash: INSTALL_HASH,
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
  });
  return pairingId;
}

/** /connect + /connect/verify を実際に通し、正規の browser pairing session cookie を得る。 */
async function obtainBrowserPairingSessionCookie(app: ReturnType<typeof createTestApp>): Promise<string> {
  const connectRes = await request(app).get('/connect');
  const csrfCookie = extractCookie(connectRes.headers['set-cookie'], 'even_connect_csrf');
  const csrfToken = csrfCookie?.split('=')[1];
  const verifyRes = await request(app)
    .post('/connect/verify')
    .set('Cookie', csrfCookie ?? '')
    .send({ csrfToken, userCode: USER_CODE });
  const sessionCookie = extractCookie(verifyRes.headers['set-cookie'], 'even_pairing_session');
  if (!sessionCookie) throw new Error('failed to obtain browser pairing session cookie in test setup');
  return sessionCookie;
}

describe('GET /product/oauth/google/start', () => {
  it('returns 401 when there is no browser pairing session cookie', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo);
    const res = await request(app).get('/product/oauth/google/start');
    expect(res.status).toBe(401);
  });

  it('redirects (302) to Google with PKCE + state + nonce when a valid session exists for a pending pairing', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo);
    const sessionCookie = await obtainBrowserPairingSessionCookie(app);
    const res = await request(app).get('/product/oauth/google/start').set('Cookie', sessionCookie);
    expect(res.status).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('code_challenge=');
    expect(location).toContain('code_challenge_method=S256');
    expect(location).toContain('state=');
    expect(location).toContain('nonce=');
  });

  it('sets an oauth state cookie and transitions the pairing to oauth_in_progress', async () => {
    const { app, productPairingRepo } = setup();
    const pairingId = await createPendingPairing(productPairingRepo);
    const sessionCookie = await obtainBrowserPairingSessionCookie(app);
    const res = await request(app).get('/product/oauth/google/start').set('Cookie', sessionCookie);
    const stateCookie = extractCookie(res.headers['set-cookie'], 'even_product_oauth_state');
    expect(stateCookie).toBeDefined();
    expect((await productPairingRepo.getById(pairingId))?.status).toBe('oauth_in_progress');
  });

  it('returns 400 when the pairing behind the session has already expired (but the browser session cookie is still valid)', async () => {
    const productPairingRepo = new InMemoryProductPairingRepository();
    // pairingのTTLをbrowser pairing sessionのTTL(10分)より大幅に短くし、
    // 「pairingだけが先に失効し、browser sessionはまだ有効」という状況を再現する。
    await productPairingRepo.create({
      pairingId: 'pairing-1',
      userCodeHash: hashValue(USER_CODE.replace('-', '')),
      installationIdHash: INSTALL_HASH,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 2000),
    });
    const pluginRateLimitRepo = new InMemoryPluginRateLimitRepository();
    const app = createTestApp({ clock: fixedClock(NOW), productPairingRepo, pluginRateLimitRepo });
    const sessionCookie = await obtainBrowserPairingSessionCookie(app);

    const laterApp = createTestApp({ clock: fixedClock(new Date(NOW.getTime() + 3000)), productPairingRepo });
    const res = await request(laterApp).get('/product/oauth/google/start').set('Cookie', sessionCookie);
    expect(res.status).toBe(400);
  });
});

describe('GET /product/oauth/google/callback', () => {
  async function startOAuth(app: ReturnType<typeof createTestApp>) {
    const sessionCookie = await obtainBrowserPairingSessionCookie(app);
    const startRes = await request(app).get('/product/oauth/google/start').set('Cookie', sessionCookie);
    const stateCookie = extractCookie(startRes.headers['set-cookie'], 'even_product_oauth_state');
    const location = new URL(startRes.headers.location as string);
    const state = location.searchParams.get('state') ?? '';
    return { stateCookie: stateCookie ?? '', state };
  }

  it('completes the flow: creates a productUser, saves the credential, and approves the pairing', async () => {
    const { fn } = fakeExchange({ refreshToken: 'rt-1', googleSubject: 'google-sub-1' });
    const { app, productPairingRepo, productUserRepo, productCredentialRepo } = setup({ exchangeFn: fn });
    const pairingId = await createPendingPairing(productPairingRepo);
    const { stateCookie, state } = await startOAuth(app);

    const res = await request(app)
      .get('/product/oauth/google/callback')
      .set('Cookie', stateCookie)
      .query({ code: 'auth-code-1', state });

    expect(res.status).toBe(200);
    expect(res.text).toContain('接続しました');

    const user = await productUserRepo.findBySubjectHash(hashValue('google-sub-1'));
    expect(user).not.toBeNull();

    const pairing = await productPairingRepo.getById(pairingId);
    expect(pairing?.status).toBe('approved');
    expect(pairing?.userId).toBe(user?.userId);

    const credential = await productCredentialRepo?.getForUser(user!.userId);
    expect(credential?.refreshToken).toBe('rt-1');
  });

  it('never shows the Google subject/email on the success page', async () => {
    const { fn } = fakeExchange({ refreshToken: 'rt-1', googleSubject: 'google-sub-1' });
    const { app, productPairingRepo } = setup({ exchangeFn: fn });
    await createPendingPairing(productPairingRepo);
    const { stateCookie, state } = await startOAuth(app);
    const res = await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });
    expect(res.text).not.toContain('google-sub-1');
  });

  it('reuses an existing productUser (touchLogin) on a second login with the same Google subject', async () => {
    const { fn } = fakeExchange({ refreshToken: 'rt-1', googleSubject: 'google-sub-1' });
    const { app, productPairingRepo, productUserRepo } = setup({ exchangeFn: fn });
    await createPendingPairing(productPairingRepo);
    const { stateCookie, state } = await startOAuth(app);
    await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });
    const firstUser = await productUserRepo.findBySubjectHash(hashValue('google-sub-1'));

    // 2回目のペアリング/ログイン
    await createPendingPairing(productPairingRepo);
    const second = await startOAuth(app);
    await request(app).get('/product/oauth/google/callback').set('Cookie', second.stateCookie).query({ code: 'auth-code-2', state: second.state });
    const secondUser = await productUserRepo.findBySubjectHash(hashValue('google-sub-1'));

    expect(secondUser?.userId).toBe(firstUser?.userId);
  });

  it('rejects a missing/invalid state with a 400 error page', async () => {
    const { fn } = fakeExchange();
    const { app, productPairingRepo } = setup({ exchangeFn: fn });
    await createPendingPairing(productPairingRepo);
    const { stateCookie } = await startOAuth(app);
    const res = await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state: 'wrong-state' });
    expect(res.status).toBe(400);
  });

  it('rejects a replayed callback (state cookie already cleared after first use)', async () => {
    const { fn } = fakeExchange();
    const { app, productPairingRepo } = setup({ exchangeFn: fn });
    await createPendingPairing(productPairingRepo);
    const { stateCookie, state } = await startOAuth(app);
    const first = await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });
    expect(first.status).toBe(200);
    // stateCookie was cleared server-side; replaying without a fresh cookie must fail
    const replay = await request(app).get('/product/oauth/google/callback').query({ code: 'auth-code-1', state });
    expect(replay.status).toBe(400);
  });

  it('marks the pairing failed with oauth_identity_failed when no Google subject is returned', async () => {
    const { fn } = fakeExchange({ refreshToken: 'rt-1', googleSubject: null });
    const { app, productPairingRepo } = setup({ exchangeFn: fn });
    const pairingId = await createPendingPairing(productPairingRepo);
    const { stateCookie, state } = await startOAuth(app);
    const res = await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });
    expect(res.status).toBe(400);
    expect((await productPairingRepo.getById(pairingId))?.sanitizedErrorCode).toBe('oauth_identity_failed');
  });

  it('fails with oauth_no_refresh_token when no refresh token is returned and no credential exists yet', async () => {
    const { fn } = fakeExchange({ refreshToken: null, googleSubject: 'google-sub-1' });
    const { app, productPairingRepo } = setup({ exchangeFn: fn });
    const pairingId = await createPendingPairing(productPairingRepo);
    const { stateCookie, state } = await startOAuth(app);
    const res = await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });
    expect(res.status).toBe(400);
    expect((await productPairingRepo.getById(pairingId))?.sanitizedErrorCode).toBe('oauth_no_refresh_token');
  });

  it('does not delete an existing stored credential when a later exchange returns no refresh token', async () => {
    const first = fakeExchange({ refreshToken: 'rt-1', googleSubject: 'google-sub-1' });
    const { app, productPairingRepo, productUserRepo, productCredentialRepo } = setup({ exchangeFn: first.fn });
    await createPendingPairing(productPairingRepo);
    const firstFlow = await startOAuth(app);
    await request(app).get('/product/oauth/google/callback').set('Cookie', firstFlow.stateCookie).query({ code: 'auth-code-1', state: firstFlow.state });
    const user = await productUserRepo.findBySubjectHash(hashValue('google-sub-1'));

    // 2回目: refresh tokenが返らない(Googleの仕様上あり得る)。既存credentialは消してはいけない。
    await createPendingPairing(productPairingRepo);
    const secondFlow = await startOAuth(app);
    const res = await request(app).get('/product/oauth/google/callback').set('Cookie', secondFlow.stateCookie).query({ code: 'auth-code-2', state: secondFlow.state });
    expect(res.status).toBe(200);
    const credential = await productCredentialRepo?.getForUser(user!.userId);
    expect(credential?.refreshToken).toBe('rt-1');
  });

  it('returns 503 product_encryption_not_configured and does not approve the pairing when encryption is unavailable', async () => {
    const { fn } = fakeExchange({ refreshToken: 'rt-1', googleSubject: 'google-sub-1' });
    const { app, productPairingRepo } = setup({ exchangeFn: fn, useFakeCipher: false });
    const pairingId = await createPendingPairing(productPairingRepo);
    const { stateCookie, state } = await startOAuth(app);
    const res = await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });
    expect(res.status).toBe(503);
    expect((await productPairingRepo.getById(pairingId))?.status).not.toBe('approved');
  });

  it('never logs the raw refresh token, access token, or authorization code', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fn } = fakeExchange({ refreshToken: 'SECRET-REFRESH-TOKEN', googleSubject: 'google-sub-1' });
    const { app, productPairingRepo } = setup({ exchangeFn: fn });
    await createPendingPairing(productPairingRepo);
    const { stateCookie, state } = await startOAuth(app);
    await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'SECRET-AUTH-CODE', state });
    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).not.toContain('SECRET-REFRESH-TOKEN');
    expect(allLogText).not.toContain('SECRET-AUTH-CODE');
    logSpy.mockRestore();
  });

  it('calls the exchange function with the product OAuth config (client id/secret/redirect uri), never the dev config', async () => {
    const { fn, calls } = fakeExchange({ refreshToken: 'rt-1', googleSubject: 'google-sub-1' });
    const { app, productPairingRepo } = setup({ exchangeFn: fn });
    await createPendingPairing(productPairingRepo);
    const { stateCookie, state } = await startOAuth(app);
    await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.clientId).toBe(TEST_PRODUCT_OAUTH_CONFIG.clientId);
    expect(calls[0]?.clientSecret).toBe(TEST_PRODUCT_OAUTH_CONFIG.clientSecret);
    expect(calls[0]?.redirectUri).toBe(TEST_PRODUCT_OAUTH_CONFIG.redirectUri);
    expect(calls[0]?.clientId).not.toBe(TEST_OAUTH_CONFIG.clientId);
  });

  describe('token exchange failure classification (bugfix: was previously lumped into one generic code)', () => {
    it('classifies a Google invalid_grant response distinctly, without deleting the pairing or approving it', async () => {
      const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = { response: { status: 400, data: { error: 'invalid_grant' } } };
      const { app, productPairingRepo } = setup({ exchangeFn: throwingExchange(err) });
      const pairingId = await createPendingPairing(productPairingRepo);
      const { stateCookie, state } = await startOAuth(app);
      const res = await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });

      expect(res.status).toBe(400);
      const pairing = await productPairingRepo.getById(pairingId);
      expect(pairing?.status).toBe('failed');
      expect(pairing?.sanitizedErrorCode).toBe('product_oauth_invalid_grant');
      const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(allLogText).toContain('product_oauth_invalid_grant');
      logSpy.mockRestore();
    });

    it('classifies an HTTP 401 (client authentication failure) as invalid_client, distinct from invalid_grant', async () => {
      const err = { response: { status: 401, data: {} } };
      const { app, productPairingRepo } = setup({ exchangeFn: throwingExchange(err) });
      const pairingId = await createPendingPairing(productPairingRepo);
      const { stateCookie, state } = await startOAuth(app);
      await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });

      const pairing = await productPairingRepo.getById(pairingId);
      expect(pairing?.sanitizedErrorCode).toBe('product_oauth_invalid_client');
    });

    it('classifies a 5xx from the token endpoint as provider_unavailable', async () => {
      const err = { response: { status: 503, data: {} } };
      const { app, productPairingRepo } = setup({ exchangeFn: throwingExchange(err) });
      const pairingId = await createPendingPairing(productPairingRepo);
      const { stateCookie, state } = await startOAuth(app);
      await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });

      const pairing = await productPairingRepo.getById(pairingId);
      expect(pairing?.sanitizedErrorCode).toBe('product_oauth_provider_unavailable');
    });

    it('never includes error_description or any raw provider response body in logs', async () => {
      const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = { response: { status: 400, data: { error: 'invalid_grant', error_description: 'SENSITIVE_DESCRIPTION_TEXT' } } };
      const { app, productPairingRepo } = setup({ exchangeFn: throwingExchange(err) });
      await createPendingPairing(productPairingRepo);
      const { stateCookie, state } = await startOAuth(app);
      await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });

      const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(allLogText).not.toContain('SENSITIVE_DESCRIPTION_TEXT');
      logSpy.mockRestore();
    });

    it('a state/PKCE validation failure is logged as product_oauth_state_failed, never misclassified as a token exchange failure', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { app, productPairingRepo } = setup();
      await createPendingPairing(productPairingRepo);
      const { stateCookie } = await startOAuth(app);
      await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state: 'wrong-state' });

      const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(allLogText).toContain('product_oauth_state_failed');
      expect(allLogText).not.toContain('product_oauth_invalid_grant');
      expect(allLogText).not.toContain('product_oauth_token_exchange_failed'); // event名自体も別
      logSpy.mockRestore();
    });
  });

  describe('KMS/credential-save failure handling (bugfix: generic failures were previously rethrown as an unhandled exception)', () => {
    it('a generic (non-EncryptionNotConfiguredError) credential save failure returns a generic error and does not approve the pairing', async () => {
      const { fn } = fakeExchange({ refreshToken: 'rt-1', googleSubject: 'google-sub-1' });
      const throwingCipher = {
        available: true,
        encrypt: async () => {
          throw new Error('KMS RPC failed (simulated)');
        },
        decrypt: async () => {
          throw new Error('KMS RPC failed (simulated)');
        },
      };
      const productPairingRepo = new InMemoryProductPairingRepository();
      const productUserRepo = new InMemoryProductUserRepository();
      const productCredentialRepo = new InMemoryGoogleCredentialRepository(throwingCipher);
      const pluginRateLimitRepo = new InMemoryPluginRateLimitRepository();
      const app = createTestApp({
        clock: fixedClock(NOW),
        productPairingRepo,
        productUserRepo,
        productCredentialRepo,
        pluginRateLimitRepo,
        productExchangeFn: fn,
      });
      const pairingId = await createPendingPairing(productPairingRepo);
      const { stateCookie, state } = await startOAuth(app);
      const res = await request(app).get('/product/oauth/google/callback').set('Cookie', stateCookie).query({ code: 'auth-code-1', state });

      expect(res.status).toBe(400); // 500ではなく、安全なgeneric error
      const pairing = await productPairingRepo.getById(pairingId);
      expect(pairing?.status).not.toBe('approved');
      expect(pairing?.sanitizedErrorCode).toBe('product_oauth_kms_failed');
    });
  });
});

describe('Phase 2I: product OAuth client / signing key isolation', () => {
  it('returns 503 on start when no product OAuth client is configured (dev OAuth is unaffected)', async () => {
    const productPairingRepo = new InMemoryProductPairingRepository();
    const app = createTestApp({ clock: fixedClock(NOW), productPairingRepo, productOAuthConfig: null });
    await createPendingPairing(productPairingRepo);
    const sessionCookie = await obtainBrowserPairingSessionCookie(app);
    const res = await request(app).get('/product/oauth/google/start').set('Cookie', sessionCookie);
    expect(res.status).toBe(503);
  });

  it('returns 503 on start when no signing key is configured', async () => {
    const productPairingRepo = new InMemoryProductPairingRepository();
    const app = createTestApp({
      clock: fixedClock(NOW),
      productPairingRepo,
      productSigningKeyProvider: new ProductSigningKeyProvider(null),
    });
    const res = await request(app).get('/product/oauth/google/start');
    expect(res.status).toBe(503);
  });

  it('builds the authorize URL using the separate product OAuth client id, never the dev client id', async () => {
    const productPairingRepo = new InMemoryProductPairingRepository();
    const app = createTestApp({ clock: fixedClock(NOW), productPairingRepo });
    await createPendingPairing(productPairingRepo);
    const sessionCookie = await obtainBrowserPairingSessionCookie(app);
    const res = await request(app).get('/product/oauth/google/start').set('Cookie', sessionCookie);
    const location = res.headers.location as string;
    expect(location).toContain(encodeURIComponent(TEST_PRODUCT_OAUTH_CONFIG.clientId));
    expect(location).not.toContain(TEST_OAUTH_CONFIG.clientId);
  });
});
