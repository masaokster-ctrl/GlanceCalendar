import { describe, expect, it } from 'vitest';
import {
  CloudKmsGoogleCredentialCipher,
  EncryptionNotConfiguredError,
  FakeGoogleCredentialCipher,
  NotConfiguredGoogleCredentialCipher,
} from '../src/product/googleCredentialCipher.js';
import { computeCredentialAad } from '../src/product/credentialAad.js';

describe('NotConfiguredGoogleCredentialCipher', () => {
  it('reports available: false', () => {
    const cipher = new NotConfiguredGoogleCredentialCipher();
    expect(cipher.available).toBe(false);
  });

  it('throws EncryptionNotConfiguredError on encrypt (never falls back to plaintext)', async () => {
    const cipher = new NotConfiguredGoogleCredentialCipher();
    await expect(cipher.encrypt('some-refresh-token', 'aad')).rejects.toBeInstanceOf(EncryptionNotConfiguredError);
  });

  it('throws EncryptionNotConfiguredError on decrypt', async () => {
    const cipher = new NotConfiguredGoogleCredentialCipher();
    await expect(cipher.decrypt({ provider: 'kms', keyName: 'x', ciphertextBase64: 'x', aadVersion: 'v1' }, 'aad')).rejects.toBeInstanceOf(
      EncryptionNotConfiguredError,
    );
  });
});

describe('FakeGoogleCredentialCipher (test-only)', () => {
  it('round-trips plaintext through encrypt/decrypt with a matching AAD', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const aad = computeCredentialAad('user-1');
    const blob = await cipher.encrypt('my-refresh-token', aad);
    const decrypted = await cipher.decrypt(blob, aad);
    expect(decrypted).toBe('my-refresh-token');
  });

  it('never stores the plaintext refresh token verbatim in the ciphertext field', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const aad = computeCredentialAad('user-1');
    const blob = await cipher.encrypt('super-secret-refresh-token', aad);
    expect(blob.ciphertextBase64).not.toContain('super-secret-refresh-token');
  });

  it('rejects decrypt when the AAD does not match the AAD used at encrypt time (user binding)', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    const blob = await cipher.encrypt('rt-1', computeCredentialAad('user-1'));
    await expect(cipher.decrypt(blob, computeCredentialAad('user-2'))).rejects.toThrow();
  });

  it('reports available: true and tracks call counts', async () => {
    const cipher = new FakeGoogleCredentialCipher();
    expect(cipher.available).toBe(true);
    const aad = computeCredentialAad('user-1');
    const blob = await cipher.encrypt('a', aad);
    await cipher.decrypt(blob, aad);
    expect(cipher.encryptCallCount).toBe(1);
    expect(cipher.decryptCallCount).toBe(1);
  });
});

interface FakeKmsCall {
  name: string;
  plaintext?: Buffer;
  ciphertext?: Buffer;
  additionalAuthenticatedData?: Buffer;
}

/** 実KMSへは一切アクセスしないFake。AAD不一致を検出してKMSのAEAD拒否動作を模倣する。 */
class FakeKmsClient {
  public encryptCalls: FakeKmsCall[] = [];
  public decryptCalls: FakeKmsCall[] = [];

  async encrypt(req: { name: string; plaintext: Buffer; additionalAuthenticatedData: Buffer }): Promise<[{ ciphertext: Buffer }]> {
    this.encryptCalls.push(req);
    // 簡易的な「暗号化」: AADを長さプレフィックス付きで埋め込みbase64化するだけ
    // (実際の暗号強度は不要、AAD検証のテストが目的。AAD自体に'|'等の区切り文字が含まれ得るため
    // 固定長プレフィックスを使い、区切り文字方式による誤検出を避ける)。
    const aadLength = Buffer.alloc(4);
    aadLength.writeUInt32BE(req.additionalAuthenticatedData.length, 0);
    const packed = Buffer.concat([aadLength, req.additionalAuthenticatedData, req.plaintext]);
    return [{ ciphertext: Buffer.from(packed.toString('base64'), 'utf8') }];
  }

  async decrypt(req: { name: string; ciphertext: Buffer; additionalAuthenticatedData: Buffer }): Promise<[{ plaintext: Buffer }]> {
    this.decryptCalls.push(req);
    const packed = Buffer.from(req.ciphertext.toString('utf8'), 'base64');
    const aadLength = packed.readUInt32BE(0);
    const storedAad = packed.subarray(4, 4 + aadLength);
    const plaintext = packed.subarray(4 + aadLength);
    if (!storedAad.equals(req.additionalAuthenticatedData)) {
      throw new Error('FakeKmsClient: AAD mismatch (simulates real KMS AEAD rejection)');
    }
    return [{ plaintext }];
  }
}

const KEY_NAME = 'projects/test-project/locations/asia-northeast1/keyRings/even-calendar-product/cryptoKeys/google-oauth-refresh-token';

describe('CloudKmsGoogleCredentialCipher', () => {
  it('encrypts and decrypts round-trip via the injected KMS client, using AAD', async () => {
    const kmsClient = new FakeKmsClient();
    const cipher = new CloudKmsGoogleCredentialCipher(KEY_NAME, kmsClient);
    const aad = computeCredentialAad('user-1');
    const encrypted = await cipher.encrypt('my-refresh-token', aad);
    expect(encrypted.provider).toBe('kms');
    expect(encrypted.keyName).toBe(KEY_NAME);
    expect(encrypted.ciphertextBase64).not.toContain('my-refresh-token');

    const decrypted = await cipher.decrypt(encrypted, aad);
    expect(decrypted).toBe('my-refresh-token');
  });

  it('passes the exact keyName resource to the KMS client', async () => {
    const kmsClient = new FakeKmsClient();
    const cipher = new CloudKmsGoogleCredentialCipher(KEY_NAME, kmsClient);
    await cipher.encrypt('rt', computeCredentialAad('user-1'));
    expect(kmsClient.encryptCalls[0]?.name).toBe(KEY_NAME);
  });

  it('rejects decrypt when the AAD does not match (cross-user ciphertext cannot be decrypted)', async () => {
    const kmsClient = new FakeKmsClient();
    const cipher = new CloudKmsGoogleCredentialCipher(KEY_NAME, kmsClient);
    const encrypted = await cipher.encrypt('rt-1', computeCredentialAad('user-1'));
    await expect(cipher.decrypt(encrypted, computeCredentialAad('user-2'))).rejects.toThrow();
  });

  it('rejects a corrupted ciphertext rather than silently returning garbage', async () => {
    const kmsClient = new FakeKmsClient();
    const cipher = new CloudKmsGoogleCredentialCipher(KEY_NAME, kmsClient);
    const aad = computeCredentialAad('user-1');
    const encrypted = await cipher.encrypt('rt-1', aad);
    const corrupted = { ...encrypted, ciphertextBase64: Buffer.from('not-valid-packed-data', 'utf8').toString('base64') };
    await expect(cipher.decrypt(corrupted, aad)).rejects.toThrow();
  });

  it('propagates a KMS-unavailable error rather than falling back to plaintext', async () => {
    const throwingClient = {
      encrypt: async () => {
        throw new Error('KMS unavailable (simulated)');
      },
      decrypt: async () => {
        throw new Error('KMS unavailable (simulated)');
      },
    };
    const cipher = new CloudKmsGoogleCredentialCipher(KEY_NAME, throwingClient);
    await expect(cipher.encrypt('rt', computeCredentialAad('user-1'))).rejects.toThrow('KMS unavailable');
  });

  it('never logs or exposes the plaintext refresh token via the encrypted value', async () => {
    const kmsClient = new FakeKmsClient();
    const cipher = new CloudKmsGoogleCredentialCipher(KEY_NAME, kmsClient);
    const encrypted = await cipher.encrypt('EXTREMELY-SECRET-TOKEN', computeCredentialAad('user-1'));
    expect(JSON.stringify(encrypted)).not.toContain('EXTREMELY-SECRET-TOKEN');
  });
});
