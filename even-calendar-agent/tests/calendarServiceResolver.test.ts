import { describe, expect, it, vi } from 'vitest';
import { createCalendarServiceResolver } from '../src/product/calendarServiceResolver.js';
import type { GoogleOAuthConfig } from '../src/auth/googleOAuthClient.js';
import { InMemoryGoogleCredentialRepository } from '../src/product/productGoogleCredentialRepository.js';
import { FakeGoogleCredentialCipher } from '../src/product/googleCredentialCipher.js';
import { createCalendarService } from '../src/calendar/calendarService.js';
import { FakeCalendarClient } from '../src/calendar/calendarClient.js';

const DEV_CONFIG: GoogleOAuthConfig = { clientId: 'dev-client-id', clientSecret: 'dev-secret', redirectUri: 'https://dev.example/callback' };
const PRODUCT_CONFIG: GoogleOAuthConfig = { clientId: 'product-client-id', clientSecret: 'product-secret', redirectUri: 'https://product.example/callback' };

function fakeCalendarService() {
  return createCalendarService(new FakeCalendarClient());
}

describe('createCalendarServiceResolver — dev/product OAuth client separation (Phase 2K regression)', () => {
  it('uses productOAuthConfig (never devOAuthConfig) to refresh a product user credential', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const credentialRepo = new InMemoryGoogleCredentialRepository(cipher);
    await credentialRepo.saveForUser({ userId: 'user-1', refreshToken: 'product-refresh-token', grantedScopes: ['openid'], now: new Date() });

    const seenConfigs: GoogleOAuthConfig[] = [];
    const seenRefreshTokens: string[] = [];
    const service = fakeCalendarService();
    const resolver = createCalendarServiceResolver({
      productOAuthConfig: PRODUCT_CONFIG,
      productCredentialRepo: credentialRepo,
      devOAuthConfig: DEV_CONFIG,
      getDevRefreshToken: async () => {
        throw new Error('dev refresh token path must not be used for a product userId');
      },
      buildCalendarService: (config, refreshToken) => {
        seenConfigs.push(config);
        seenRefreshTokens.push(refreshToken);
        return service;
      },
    });

    const result = await resolver('user-1');
    expect(result).toBe(service);
    expect(seenConfigs).toEqual([PRODUCT_CONFIG]);
    expect(seenRefreshTokens).toEqual(['product-refresh-token']);
  });

  it('uses devOAuthConfig (never productOAuthConfig) when userId is absent', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const credentialRepo = new InMemoryGoogleCredentialRepository(cipher);

    const seenConfigs: GoogleOAuthConfig[] = [];
    const service = fakeCalendarService();
    const resolver = createCalendarServiceResolver({
      productOAuthConfig: PRODUCT_CONFIG,
      productCredentialRepo: credentialRepo,
      devOAuthConfig: DEV_CONFIG,
      getDevRefreshToken: async () => 'dev-refresh-token',
      buildCalendarService: (config, refreshToken) => {
        seenConfigs.push(config);
        expect(refreshToken).toBe('dev-refresh-token');
        return service;
      },
    });

    const result = await resolver(null);
    expect(result).toBe(service);
    expect(seenConfigs).toEqual([DEV_CONFIG]);
  });

  it('never cross-uses dev/product client across repeated calls with and without userId', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const credentialRepo = new InMemoryGoogleCredentialRepository(cipher);
    await credentialRepo.saveForUser({ userId: 'user-1', refreshToken: 'product-refresh-token', grantedScopes: ['openid'], now: new Date() });

    const seenConfigs: GoogleOAuthConfig[] = [];
    const service = fakeCalendarService();
    const resolver = createCalendarServiceResolver({
      productOAuthConfig: PRODUCT_CONFIG,
      productCredentialRepo: credentialRepo,
      devOAuthConfig: DEV_CONFIG,
      getDevRefreshToken: async () => 'dev-refresh-token',
      buildCalendarService: (config) => {
        seenConfigs.push(config);
        return service;
      },
    });

    await resolver('user-1');
    await resolver(null);
    await resolver('user-1');
    expect(seenConfigs).toEqual([PRODUCT_CONFIG, DEV_CONFIG, PRODUCT_CONFIG]);
  });

  it('returns null without calling buildCalendarService when productOAuthConfig is not configured', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const credentialRepo = new InMemoryGoogleCredentialRepository(cipher);
    await credentialRepo.saveForUser({ userId: 'user-1', refreshToken: 'rt', grantedScopes: [], now: new Date() });

    const build = vi.fn();
    const resolver = createCalendarServiceResolver({
      productOAuthConfig: null,
      productCredentialRepo: credentialRepo,
      devOAuthConfig: DEV_CONFIG,
      getDevRefreshToken: async () => 'dev-refresh-token',
      buildCalendarService: build,
    });

    const result = await resolver('user-1');
    expect(result).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it('returns null when no credential exists for the product user', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const credentialRepo = new InMemoryGoogleCredentialRepository(cipher);
    const build = vi.fn();
    const resolver = createCalendarServiceResolver({
      productOAuthConfig: PRODUCT_CONFIG,
      productCredentialRepo: credentialRepo,
      devOAuthConfig: DEV_CONFIG,
      getDevRefreshToken: async () => 'dev-refresh-token',
      buildCalendarService: build,
    });

    const result = await resolver('unknown-user');
    expect(result).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it('returns null when the product credential has been revoked', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const credentialRepo = new InMemoryGoogleCredentialRepository(cipher);
    await credentialRepo.saveForUser({ userId: 'user-1', refreshToken: 'rt', grantedScopes: [], now: new Date() });
    await credentialRepo.revokeForUser('user-1', new Date());

    const build = vi.fn();
    const resolver = createCalendarServiceResolver({
      productOAuthConfig: PRODUCT_CONFIG,
      productCredentialRepo: credentialRepo,
      devOAuthConfig: DEV_CONFIG,
      getDevRefreshToken: async () => 'dev-refresh-token',
      buildCalendarService: build,
    });

    const result = await resolver('user-1');
    expect(result).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it('returns null when the dev refresh token store has no token', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const credentialRepo = new InMemoryGoogleCredentialRepository(cipher);
    const build = vi.fn();
    const resolver = createCalendarServiceResolver({
      productOAuthConfig: PRODUCT_CONFIG,
      productCredentialRepo: credentialRepo,
      devOAuthConfig: DEV_CONFIG,
      getDevRefreshToken: async () => null,
      buildCalendarService: build,
    });

    const result = await resolver(undefined);
    expect(result).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it('returns null and logs a sanitized code (not the raw error) when credential decrypt/KMS lookup throws, without crashing', async () => {
    const throwingCredentialRepo = {
      getForUser: vi.fn().mockRejectedValue(new Error('SENSITIVE_KMS_DETAIL')),
      saveForUser: vi.fn(),
      revokeForUser: vi.fn(),
    };
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const build = vi.fn();

    const resolver = createCalendarServiceResolver({
      productOAuthConfig: PRODUCT_CONFIG,
      productCredentialRepo: throwingCredentialRepo,
      devOAuthConfig: DEV_CONFIG,
      getDevRefreshToken: async () => 'dev-refresh-token',
      buildCalendarService: build,
    });

    const result = await resolver('user-1');
    expect(result).toBeNull();
    expect(build).not.toHaveBeenCalled();

    const allLogText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogText).toContain('product_google_credential_decrypt_failed');
    expect(allLogText).not.toContain('SENSITIVE_KMS_DETAIL');
    logSpy.mockRestore();
  });
});
