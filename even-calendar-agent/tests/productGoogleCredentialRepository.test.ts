import { describe, expect, it } from 'vitest';
import {
  InMemoryGoogleCredentialRepository,
} from '../src/product/productGoogleCredentialRepository.js';
import { EncryptionNotConfiguredError, FakeGoogleCredentialCipher, NotConfiguredGoogleCredentialCipher } from '../src/product/googleCredentialCipher.js';

const NOW = new Date('2026-07-23T05:00:00Z');

describe('GoogleCredentialRepository with NotConfiguredGoogleCredentialCipher', () => {
  it('saveForUser rejects with EncryptionNotConfiguredError and never persists plaintext', async () => {
    const cipher = new NotConfiguredGoogleCredentialCipher();
    const repo = new InMemoryGoogleCredentialRepository(cipher);
    await expect(
      repo.saveForUser({ userId: 'user-1', refreshToken: 'plaintext-refresh-token', grantedScopes: ['openid'], now: NOW }),
    ).rejects.toBeInstanceOf(EncryptionNotConfiguredError);
    const stored = await repo.getForUser('user-1');
    expect(stored).toBeNull();
  });
});

describe('GoogleCredentialRepository with FakeGoogleCredentialCipher', () => {
  it('saves and retrieves a credential, round-tripping the refresh token via the cipher', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const repo = new InMemoryGoogleCredentialRepository(cipher);
    await repo.saveForUser({ userId: 'user-1', refreshToken: 'rt-abc', grantedScopes: ['openid', 'calendar'], now: NOW });
    const stored = await repo.getForUser('user-1');
    expect(stored).toEqual({ refreshToken: 'rt-abc', grantedScopes: ['openid', 'calendar'] });
  });

  it('returns null for a user with no stored credential', async () => {
    const repo = new InMemoryGoogleCredentialRepository(new FakeGoogleCredentialCipher());
    expect(await repo.getForUser('unknown-user')).toBeNull();
  });

  it('returns null after revokeForUser', async () => {
    const repo = new InMemoryGoogleCredentialRepository(new FakeGoogleCredentialCipher());
    await repo.saveForUser({ userId: 'user-1', refreshToken: 'rt-abc', grantedScopes: ['openid'], now: NOW });
    await repo.revokeForUser('user-1', NOW);
    expect(await repo.getForUser('user-1')).toBeNull();
  });

  it('overwrites an existing credential on a second saveForUser call (re-consent)', async () => {
    const repo = new InMemoryGoogleCredentialRepository(new FakeGoogleCredentialCipher());
    await repo.saveForUser({ userId: 'user-1', refreshToken: 'rt-old', grantedScopes: ['openid'], now: NOW });
    await repo.saveForUser({ userId: 'user-1', refreshToken: 'rt-new', grantedScopes: ['openid'], now: NOW });
    const stored = await repo.getForUser('user-1');
    expect(stored?.refreshToken).toBe('rt-new');
  });
});
