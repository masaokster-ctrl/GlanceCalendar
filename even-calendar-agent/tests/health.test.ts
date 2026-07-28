import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, TEST_AGENT_TOKEN } from './testHelpers.js';

describe('GET /health', () => {
  it('returns status ok', async () => {
    const app = createTestApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('does not require authentication', async () => {
    const app = createTestApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('allows cross-origin GET via Access-Control-Allow-Origin: *', async () => {
    const app = createTestApp();
    const res = await request(app).get('/health');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('advertises GET in Access-Control-Allow-Methods', async () => {
    const app = createTestApp();
    const res = await request(app).get('/health');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });

  it('does not set Access-Control-Allow-Credentials', async () => {
    const app = createTestApp();
    const res = await request(app).get('/health');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('responds to OPTIONS /health with 204', async () => {
    const app = createTestApp();
    const res = await request(app).options('/health');
    expect(res.status).toBe(204);
  });

  it('does not include token, secret, or OAuth information in the response', async () => {
    const app = createTestApp();
    const res = await request(app).get('/health');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(TEST_AGENT_TOKEN);
    expect(text.toLowerCase()).not.toContain('token');
    expect(text.toLowerCase()).not.toContain('secret');
    expect(text.toLowerCase()).not.toContain('oauth');
  });
});

describe('CORS scope restriction', () => {
  it('does not add wildcard CORS to /v1/chat/completions', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TEST_AGENT_TOKEN}`)
      .send({ messages: [] });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not add wildcard CORS to unauthenticated /v1/chat/completions requests', async () => {
    const app = createTestApp();
    const res = await request(app).post('/v1/chat/completions').send({ messages: [] });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not add wildcard CORS to /oauth2/status', async () => {
    const app = createTestApp();
    const res = await request(app).get('/oauth2/status');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not add wildcard CORS to /oauth2/start', async () => {
    const app = createTestApp();
    const res = await request(app).get('/oauth2/start');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not add wildcard CORS to /setup', async () => {
    const app = createTestApp();
    const res = await request(app).get('/setup');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not add wildcard CORS to /privacy', async () => {
    const app = createTestApp();
    const res = await request(app).get('/privacy');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
