import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, TEST_SETUP_ADMIN_TOKEN, extractCookie } from './testHelpers.js';
import { SESSION_COOKIE_NAME } from '../src/auth/setupSession.js';

describe('GET /setup', () => {
  it('shows a login form when there is no valid session', async () => {
    const app = createTestApp();
    const res = await request(app).get('/setup');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('<form');
    expect(res.text).toContain('name="token"');
    expect(res.text).toContain('autocomplete="off"');
  });
});

describe('POST /setup/login', () => {
  it('rejects an incorrect token with a generic error, no cookie set', async () => {
    const app = createTestApp();
    const res = await request(app).post('/setup/login').type('form').send({ token: 'wrong-token' });

    expect(res.status).toBe(401);
    expect(extractCookie(res.headers['set-cookie'], SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it('rejects a missing token field', async () => {
    const app = createTestApp();
    const res = await request(app).post('/setup/login').type('form').send({});
    expect(res.status).toBe(401);
  });

  it('accepts the correct token via timing-safe comparison and sets a signed session cookie', async () => {
    const app = createTestApp();
    const res = await request(app).post('/setup/login').type('form').send({ token: TEST_SETUP_ADMIN_TOKEN });

    expect(res.status).toBe(303);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const sessionLine = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));

    expect(sessionLine).toBeDefined();
    expect(sessionLine).toMatch(/HttpOnly/i);
    expect(sessionLine).toMatch(/Secure/i);
    expect(sessionLine).toMatch(/SameSite=Lax/i);
    expect(sessionLine).toMatch(/Path=\//i);
    expect(sessionLine).not.toContain(TEST_SETUP_ADMIN_TOKEN);
  });

  it('does not log the submitted token value', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createTestApp();

    await request(app).post('/setup/login').type('form').send({ token: TEST_SETUP_ADMIN_TOKEN });
    await request(app).post('/setup/login').type('form').send({ token: 'a-wrong-guess' });

    const allText = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(allText).not.toContain(TEST_SETUP_ADMIN_TOKEN);
    expect(allText).not.toContain('a-wrong-guess');

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('allows access to the dashboard after logging in', async () => {
    const app = createTestApp();
    const loginRes = await request(app).post('/setup/login').type('form').send({ token: TEST_SETUP_ADMIN_TOKEN });
    const sessionCookie = extractCookie(loginRes.headers['set-cookie'], SESSION_COOKIE_NAME);
    expect(sessionCookie).toBeDefined();

    const dashboardRes = await request(app).get('/setup').set('Cookie', sessionCookie!);
    expect(dashboardRes.status).toBe(200);
    expect(dashboardRes.text).toContain('未連携');
    expect(dashboardRes.text).toContain('/oauth2/start');
  });
});

describe('POST /setup/logout', () => {
  it('clears the session cookie', async () => {
    const app = createTestApp();
    const res = await request(app).post('/setup/logout');

    expect(res.status).toBe(303);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const sessionLine = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(sessionLine).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });
});
