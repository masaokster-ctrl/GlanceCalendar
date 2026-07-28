import { describe, expect, it } from 'vitest';
import { ProductSigningKeyProvider, SigningKeyNotConfiguredError } from '../src/product/productSigningKey.js';

describe('ProductSigningKeyProvider', () => {
  it('reports available: false when constructed with null (not configured)', () => {
    const provider = new ProductSigningKeyProvider(null);
    expect(provider.available).toBe(false);
  });

  it('reports available: true when constructed with a master key', () => {
    const provider = new ProductSigningKeyProvider('some-master-key');
    expect(provider.available).toBe(true);
  });

  it('throws SigningKeyNotConfiguredError when subkey() is called without a master key', () => {
    const provider = new ProductSigningKeyProvider(null);
    expect(() => provider.subkey('browser-session-v1')).toThrow(SigningKeyNotConfiguredError);
  });

  it('derives distinct subkeys for each context from the same master key', () => {
    const provider = new ProductSigningKeyProvider('master-key');
    const sessionKey = provider.subkey('browser-session-v1');
    const csrfKey = provider.subkey('csrf-v1');
    const stateKey = provider.subkey('oauth-state-v1');
    expect(new Set([sessionKey, csrfKey, stateKey]).size).toBe(3);
  });

  it('is deterministic: the same master key + context always derives the same subkey', () => {
    const provider1 = new ProductSigningKeyProvider('master-key');
    const provider2 = new ProductSigningKeyProvider('master-key');
    expect(provider1.subkey('browser-session-v1')).toBe(provider2.subkey('browser-session-v1'));
  });

  it('derives different subkeys for the same context under different master keys', () => {
    const providerA = new ProductSigningKeyProvider('master-key-a');
    const providerB = new ProductSigningKeyProvider('master-key-b');
    expect(providerA.subkey('csrf-v1')).not.toBe(providerB.subkey('csrf-v1'));
  });

  it('never derives a subkey equal to the master key itself (no direct reuse)', () => {
    const provider = new ProductSigningKeyProvider('master-key');
    expect(provider.subkey('browser-session-v1')).not.toBe('master-key');
  });
});
