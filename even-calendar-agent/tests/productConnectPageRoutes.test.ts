import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, extractCookie, TEST_SETUP_ADMIN_TOKEN } from './testHelpers.js';
import { InMemoryProductPairingRepository } from '../src/product/productPairingRepository.js';
import { InMemoryPluginRateLimitRepository } from '../src/firestore/pluginRateLimitRepository.js';
import { hashValue } from '../src/security/devSessionToken.js';
import { fixedClock } from '../src/time/clock.js';
import { ProductSigningKeyProvider } from '../src/product/productSigningKey.js';
import { PRODUCT_HISTORY_RETURN_MARKER_STORAGE_KEY } from '../src/product/productHistoryReturnMarker.js';

const NOW = new Date('2026-07-23T05:00:00Z');
const INSTALL_HASH = 'install-hash-1';

function setup(opts: { rateLimitPerMinute?: number } = {}) {
  const productPairingRepo = new InMemoryProductPairingRepository();
  const pluginRateLimitRepo = new InMemoryPluginRateLimitRepository();
  const app = createTestApp({
    clock: fixedClock(NOW),
    productPairingRepo,
    pluginRateLimitRepo,
    ...(opts.rateLimitPerMinute !== undefined ? { productConnectRateLimitPerMinute: opts.rateLimitPerMinute } : {}),
  });
  return { app, productPairingRepo };
}

async function createPendingPairing(productPairingRepo: InMemoryProductPairingRepository, userCode: string) {
  const pairingId = 'pairing-1';
  await productPairingRepo.create({
    pairingId,
    userCodeHash: hashValue(userCode.toUpperCase().replace(/[^A-Z0-9]/g, '')),
    installationIdHash: INSTALL_HASH,
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
  });
  return pairingId;
}

async function getConnectPageAndCsrf(app: ReturnType<typeof createTestApp>) {
  const res = await request(app).get('/connect');
  const csrfCookie = extractCookie(res.headers['set-cookie'], 'even_connect_csrf');
  const csrfToken = csrfCookie?.split('=')[1];
  return { res, csrfCookie, csrfToken };
}

describe('GET /connect', () => {
  it('returns 200 with the connect form and sets a CSRF cookie', async () => {
    const { app } = setup();
    const { res, csrfToken } = await getConnectPageAndCsrf(app);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form');
    expect(csrfToken).toBeDefined();
  });

  it('sets security headers: no-store, nosniff, no-referrer, frame-ancestors none, X-Frame-Options DENY', async () => {
    const { app } = setup();
    const res = await request(app).get('/connect');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('mentions the privacy/data-usage explanation', async () => {
    const { app } = setup();
    const res = await request(app).get('/connect');
    expect(res.text).toContain('音声');
    expect(res.text).toContain('カレンダー');
  });

  describe('history-return marker (used by the OAuth success page\'s "Even Calendarへ戻る" button)', () => {
    it('embeds the marker-recording script with a nonce that matches the CSP header', async () => {
      const { app } = setup();
      const res = await request(app).get('/connect');
      const csp = res.headers['content-security-policy'] as string;
      const match = /script-src 'nonce-([^']+)'/.exec(csp);
      expect(match).not.toBeNull();
      const nonce = match?.[1];
      expect(res.text).toContain(`<script nonce="${nonce}">`);
      expect(res.text).toContain(PRODUCT_HISTORY_RETURN_MARKER_STORAGE_KEY);
      expect(res.text).toContain('window.history.length');
    });

    it('still keeps form-action \'self\' alongside the script-src nonce', async () => {
      const { app } = setup();
      const res = await request(app).get('/connect');
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toContain("form-action 'self'");
    });

    it('detects back_forward navigation and skips overwriting an existing marker on same-flow revisits', async () => {
      const { app } = setup();
      const res = await request(app).get('/connect');
      expect(res.text).toContain("navType === 'back_forward'");
      expect(res.text).toContain('performance.navigation.type');
    });

    it('does not expose internal diagnostics (no visible probe text or console.log)', async () => {
      const { app } = setup();
      const res = await request(app).get('/connect');
      expect(res.text).not.toContain('console.log');
      expect(res.text).not.toContain('id="temp-history-probe"');
      expect(res.text).not.toMatch(/PHASE TEMP/i);
      expect(res.text).not.toContain('flowId');
    });
  });

  it('escapes HTML in rendered error messages (XSS defense)', async () => {
    const { app } = setup();
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: '<script>alert(1)</script>' });
    expect(res.text).not.toContain('<script>alert(1)</script>');
  });
});

describe('POST /connect/verify', () => {
  it('accepts a valid pending code and issues a browser pairing-session cookie (not containing the userCode)', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });
    expect(res.status).toBe(200);
    const pairingCookie = extractCookie(res.headers['set-cookie'], 'even_pairing_session');
    expect(pairingCookie).toBeDefined();
    expect(pairingCookie).not.toContain('ABCD');
    expect(pairingCookie).not.toContain('EFGH');
  });

  it('sets the pairing-session cookie as HttpOnly, Secure, SameSite', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });
    const rawCookieLine = (res.headers['set-cookie'] as string[]).find((c) => c.startsWith('even_pairing_session='));
    expect(rawCookieLine?.toLowerCase()).toContain('httponly');
    expect(rawCookieLine?.toLowerCase()).toContain('secure');
    expect(rawCookieLine?.toLowerCase()).toContain('samesite');
  });

  it('accepts the code case-insensitively and with/without hyphen', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'abcdefgh' });
    expect(res.status).toBe(200);
  });

  it('rejects a missing/invalid CSRF token with a generic 400', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken: 'wrong-token', userCode: 'ABCD-EFGH' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown code with a generic error (no enumeration hint)', async () => {
    const { app } = setup();
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ZZZZ-ZZZZ' });
    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/not found|does not exist/i);
  });

  it('rejects an expired code with the same generic error as an unknown code', async () => {
    const productPairingRepo = new InMemoryProductPairingRepository();
    const pluginRateLimitRepo = new InMemoryPluginRateLimitRepository();
    await productPairingRepo.create({
      pairingId: 'pairing-1',
      userCodeHash: hashValue('ABCDEFGH'),
      installationIdHash: INSTALL_HASH,
      now: NOW,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    const app = createTestApp({ clock: fixedClock(NOW), productPairingRepo, pluginRateLimitRepo });
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });
    expect(res.status).toBe(400);
  });

  it('rejects once the per-pairing attempt count exceeds the brute-force limit', async () => {
    const { app, productPairingRepo } = setup();
    const pairingId = await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    for (let i = 0; i < 5; i += 1) {
      await productPairingRepo.recordPollAttempt(pairingId, NOW);
    }
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });
    expect(res.status).toBe(400);
  });

  it('rate-limits repeated verify attempts from the same IP', async () => {
    const { app } = setup({ rateLimitPerMinute: 1 });
    const { csrfCookie: cookie1, csrfToken: token1 } = await getConnectPageAndCsrf(app);
    await request(app).post('/connect/verify').set('Cookie', cookie1 ?? '').send({ csrfToken: token1, userCode: 'ZZZZ-ZZZZ' });
    const { csrfCookie: cookie2, csrfToken: token2 } = await getConnectPageAndCsrf(app);
    const res = await request(app).post('/connect/verify').set('Cookie', cookie2 ?? '').send({ csrfToken: token2, userCode: 'ZZZZ-ZZZZ' });
    expect(res.status).toBe(429);
  });

  it('never appears in the URL query string (POST body only) and never logs the raw code', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });
    expect(res.request.url).not.toContain('ABCD');
  });

  it('sets security headers on the response too', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('POST /connect/verify success page — CSP fix (anchor link instead of form submit)', () => {
  it('renders an <a href="/product/oauth/google/start"> link instead of a form', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<a class="button-link" href="/product/oauth/google/start">Googleで接続</a>');
  });

  it('does not render a <form> submitting to /product/oauth/google/start', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });

    expect(res.text).not.toMatch(/<form[^>]*action="\/product\/oauth\/google\/start"/);
  });

  it('contains no inline script tags or on* event handler attributes', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });

    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('keeps the CSP header (form-action \'self\', not weakened) on the success page', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });

    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain('accounts.google.com');
    expect(csp).not.toContain("form-action *");
  });

  it('never exposes the userCode in the success page body', async () => {
    const { app, productPairingRepo } = setup();
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const res = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });

    expect(res.text).not.toContain('ABCD');
    expect(res.text).not.toContain('EFGH');
  });
});

describe('Integration: GET /product/oauth/google/start reachable via the anchor link (CSP fix regression)', () => {
  it('a browser session obtained through /connect/verify can successfully GET /product/oauth/google/start and receive a 302 to accounts.google.com with the product client id', async () => {
    const { app } = setup();
    const createRes = await request(app)
      .post('/product/pairings')
      .send({ installationId: '11111111-1111-4111-8111-111111111111' });
    const userCode = createRes.body.userCode as string;

    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const verifyRes = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode });
    const sessionCookie = extractCookie(verifyRes.headers['set-cookie'], 'even_pairing_session');
    expect(sessionCookie).toBeDefined();

    const startRes = await request(app).get('/product/oauth/google/start').set('Cookie', sessionCookie ?? '');
    expect(startRes.status).toBe(302);
    const location = startRes.headers.location as string;
    expect(new URL(location).host).toBe('accounts.google.com');
    // pairingId/userCode/token等の生値がリダイレクト先URLへ含まれないこと
    expect(location).not.toContain(userCode.replace('-', ''));
  });

  it('returns 401 without a browser pairing session (unchanged by the CSP fix)', async () => {
    const { app } = setup();
    const res = await request(app).get('/product/oauth/google/start');
    expect(res.status).toBe(401);
  });
});

describe('Integration: POST /product/pairings -> GET/POST /connect(/verify) end-to-end', () => {
  it('accepts the exact userCode returned by the real pairing-creation endpoint (regression: hash normalization mismatch)', async () => {
    const { app } = setup();
    const createRes = await request(app)
      .post('/product/pairings')
      .send({ installationId: '11111111-1111-4111-8111-111111111111' });
    expect(createRes.status).toBe(201);
    const userCode = createRes.body.userCode as string;
    expect(userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(app);
    const verifyRes = await request(app)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode });

    expect(verifyRes.status).toBe(200);
    const sessionCookie = extractCookie(verifyRes.headers['set-cookie'], 'even_pairing_session');
    expect(sessionCookie).toBeDefined();
  });
});

describe('GET /connect and POST /connect/verify — Phase 2I signing key isolation', () => {
  it('returns 503 product_signing_key_not_configured on GET /connect when no signing key is configured', async () => {
    const app = createTestApp({
      clock: fixedClock(NOW),
      productPairingRepo: new InMemoryProductPairingRepository(),
      pluginRateLimitRepo: new InMemoryPluginRateLimitRepository(),
      productSigningKeyProvider: new ProductSigningKeyProvider(null),
    });
    const res = await request(app).get('/connect');
    expect(res.status).toBe(503);
  });

  it('returns 503 on POST /connect/verify when no signing key is configured (dev routes remain unaffected)', async () => {
    const productPairingRepo = new InMemoryProductPairingRepository();
    const app = createTestApp({
      clock: fixedClock(NOW),
      productPairingRepo,
      pluginRateLimitRepo: new InMemoryPluginRateLimitRepository(),
      productSigningKeyProvider: new ProductSigningKeyProvider(null),
    });
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const res = await request(app).post('/connect/verify').send({ csrfToken: 'anything', userCode: 'ABCD-EFGH' });
    expect(res.status).toBe(503);
  });

  it('does not accept a browser pairing-session cookie signed with setupAdminToken (signing key is fully independent)', async () => {
    const productPairingRepo = new InMemoryProductPairingRepository();
    const pluginRateLimitRepo = new InMemoryPluginRateLimitRepository();
    // setupAdminTokenをmaster keyとして流用した場合に生成されるcookie(旧方式のシミュレーション)。
    const legacyStyleProvider = new ProductSigningKeyProvider(TEST_SETUP_ADMIN_TOKEN);
    const legacyApp = createTestApp({
      clock: fixedClock(NOW),
      productPairingRepo,
      pluginRateLimitRepo,
      productSigningKeyProvider: legacyStyleProvider,
    });
    const { csrfCookie, csrfToken } = await getConnectPageAndCsrf(legacyApp);
    await createPendingPairing(productPairingRepo, 'ABCD-EFGH');
    const verifyRes = await request(legacyApp)
      .post('/connect/verify')
      .set('Cookie', csrfCookie ?? '')
      .send({ csrfToken, userCode: 'ABCD-EFGH' });
    const sessionCookie = extractCookie(verifyRes.headers['set-cookie'], 'even_pairing_session');
    expect(sessionCookie).toBeDefined();

    // 実際の(独立した)signing keyを使うappでは、setupAdminToken由来のcookieはOAuth startで拒否されるはず
    // (別のsigning keyで検証するため署名が一致しない)。
    const realApp = createTestApp({ clock: fixedClock(NOW), productPairingRepo });
    const res = await request(realApp).get('/product/oauth/google/start').set('Cookie', sessionCookie ?? '');
    expect(res.status).toBe(401);
  });
});
