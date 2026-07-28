import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from './testHelpers.js';

describe('GET /privacy', () => {
  it('returns a readable HTML privacy page', async () => {
    const app = createTestApp();
    const res = await request(app).get('/privacy');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('プライバシーポリシー');
    expect(res.text).toContain('永続的に保存しません');
  });
});
