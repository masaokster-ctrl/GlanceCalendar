import { describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../src/time/clock.js';
import { InMemoryRefreshTokenStore, SecretManagerRefreshTokenStore } from '../src/auth/refreshTokenStore.js';

describe('InMemoryRefreshTokenStore', () => {
  it('reports null (not connected) before any token is saved', async () => {
    const store = new InMemoryRefreshTokenStore();
    expect(await store.getRefreshToken()).toBeNull();
  });

  it('saves a non-empty refresh token', async () => {
    const store = new InMemoryRefreshTokenStore();
    await store.saveRefreshToken('refresh-token-value');
    expect(await store.getRefreshToken()).toBe('refresh-token-value');
    expect(store.saveCallCount).toBe(1);
  });

  it('does not save an empty refresh token', async () => {
    const store = new InMemoryRefreshTokenStore();
    await store.saveRefreshToken('');
    expect(await store.getRefreshToken()).toBeNull();
    expect(store.saveCallCount).toBe(0);
  });
});

function fakeSecretManagerClient(initialPayload: string | null) {
  let currentPayload = initialPayload;
  const addSecretVersion = vi.fn(async ({ payload }: { payload: { data: Buffer } }) => {
    currentPayload = payload.data.toString('utf8');
    return [{}];
  });
  const accessSecretVersion = vi.fn(async () => {
    if (currentPayload === null) {
      const err = new Error('NOT_FOUND') as Error & { code: number };
      err.code = 5;
      throw err;
    }
    return [{ payload: { data: Buffer.from(currentPayload, 'utf8') } }];
  });
  return { addSecretVersion, accessSecretVersion } as const;
}

describe('SecretManagerRefreshTokenStore', () => {
  it('returns null when the secret has no version yet (not connected)', async () => {
    const client = fakeSecretManagerClient(null);
    const store = new SecretManagerRefreshTokenStore({
      client,
      projectId: 'test-project',
      secretName: 'google-calendar-refresh-token',
      clock: fixedClock('2026-07-21T01:00:00.000Z'),
    });

    expect(await store.getRefreshToken()).toBeNull();
  });

  it('reads the latest version value', async () => {
    const client = fakeSecretManagerClient('the-refresh-token');
    const store = new SecretManagerRefreshTokenStore({
      client,
      projectId: 'test-project',
      secretName: 'google-calendar-refresh-token',
      clock: fixedClock('2026-07-21T01:00:00.000Z'),
    });

    expect(await store.getRefreshToken()).toBe('the-refresh-token');
  });

  it('caches the value for up to 5 minutes and invalidates on save', async () => {
    const client = fakeSecretManagerClient('token-v1');
    let now = Date.parse('2026-07-21T01:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const store = new SecretManagerRefreshTokenStore({
      client,
      projectId: 'test-project',
      secretName: 'google-calendar-refresh-token',
      clock,
    });

    expect(await store.getRefreshToken()).toBe('token-v1');
    expect(client.accessSecretVersion).toHaveBeenCalledTimes(1);

    // 4分後: キャッシュ内なので再アクセスしない
    now += 4 * 60 * 1000;
    expect(await store.getRefreshToken()).toBe('token-v1');
    expect(client.accessSecretVersion).toHaveBeenCalledTimes(1);

    // saveRefreshTokenでキャッシュ無効化される
    await store.saveRefreshToken('token-v2');
    expect(await store.getRefreshToken()).toBe('token-v2');
    expect(client.accessSecretVersion).toHaveBeenCalledTimes(2);
  });

  it('re-fetches after the 5 minute cache window elapses', async () => {
    const client = fakeSecretManagerClient('token-v1');
    let now = Date.parse('2026-07-21T01:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const store = new SecretManagerRefreshTokenStore({
      client,
      projectId: 'test-project',
      secretName: 'google-calendar-refresh-token',
      clock,
    });

    await store.getRefreshToken();
    now += 6 * 60 * 1000;
    await store.getRefreshToken();
    expect(client.accessSecretVersion).toHaveBeenCalledTimes(2);
  });

  it('does not add a new version when saving an empty value', async () => {
    const client = fakeSecretManagerClient('token-v1');
    const store = new SecretManagerRefreshTokenStore({
      client,
      projectId: 'test-project',
      secretName: 'google-calendar-refresh-token',
      clock: fixedClock('2026-07-21T01:00:00.000Z'),
    });

    await store.saveRefreshToken('');
    expect(client.addSecretVersion).not.toHaveBeenCalled();
  });
});
