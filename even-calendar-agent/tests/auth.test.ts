import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';

const EXPECTED_TOKEN = 'expected-token';

describe('POST /v1/chat/completions auth', () => {
  const app = createTestApp({ agentToken: EXPECTED_TOKEN });

  it('rejects requests with no Authorization header', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'x', messages: [] });

    expect(res.status).toBe(401);
  });

  it('rejects requests with a wrong token', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer wrong-token')
      .send({ model: 'x', messages: [] });

    expect(res.status).toBe(401);
  });

  it('rejects a non-Bearer Authorization scheme', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Basic ${EXPECTED_TOKEN}`)
      .send({ model: 'x', messages: [] });

    expect(res.status).toBe(401);
  });

  it('accepts requests with the correct Bearer token', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${EXPECTED_TOKEN}`)
      .send({ model: 'x', messages: [{ role: 'user', content: 'hi' }], stream: false });

    expect(res.status).toBe(200);
  });
});
