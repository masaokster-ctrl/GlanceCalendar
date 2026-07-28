import type { Firestore } from '@google-cloud/firestore';
import { normalizeDate, normalizeNullableDate } from '../firestore/firestoreDates.js';
import type { ProductGoogleCredentialDoc } from '../firestore/models.js';
import type { GoogleCredentialCipher } from './googleCredentialCipher.js';
import { computeCredentialAad } from './credentialAad.js';

export interface SaveCredentialParams {
  userId: string;
  refreshToken: string;
  grantedScopes: string[];
  now: Date;
}

/**
 * 平文refresh tokenはこのrepositoryの外(呼び出し側)へ一切出さない。getForUserは復号済み平文を
 * 返すが、これはCalendar APIクライアント生成のためだけに使い、ログ・レスポンスへ含めないこと。
 */
export interface GoogleCredentialRepository {
  getForUser(userId: string): Promise<{ refreshToken: string; grantedScopes: string[] } | null>;
  saveForUser(params: SaveCredentialParams): Promise<void>;
  revokeForUser(userId: string, now: Date): Promise<void>;
}

function normalizeDoc(doc: ProductGoogleCredentialDoc): ProductGoogleCredentialDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    updatedAt: normalizeDate(doc.updatedAt),
    revokedAt: normalizeNullableDate(doc.revokedAt),
    lastRefreshAt: normalizeNullableDate(doc.lastRefreshAt),
  };
}

const COLLECTION = 'productGoogleCredentials';

export class FirestoreGoogleCredentialRepository implements GoogleCredentialRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly cipher: GoogleCredentialCipher,
  ) {}

  async getForUser(userId: string): Promise<{ refreshToken: string; grantedScopes: string[] } | null> {
    const snapshot = await this.firestore.collection(COLLECTION).doc(userId).get();
    if (!snapshot.exists) return null;
    const doc = normalizeDoc(snapshot.data() as ProductGoogleCredentialDoc);
    if (doc.revokedAt !== null) return null;
    const refreshToken = await this.cipher.decrypt(
      { provider: doc.cipherProvider, keyName: doc.keyName, ciphertextBase64: doc.ciphertextBase64, aadVersion: doc.aadVersion },
      computeCredentialAad(userId),
    );
    return { refreshToken, grantedScopes: doc.grantedScopes };
  }

  async saveForUser(params: SaveCredentialParams): Promise<void> {
    const encrypted = await this.cipher.encrypt(params.refreshToken, computeCredentialAad(params.userId));
    const ref = this.firestore.collection(COLLECTION).doc(params.userId);
    const snapshot = await ref.get();
    if (snapshot.exists) {
      await ref.set(
        {
          cipherProvider: encrypted.provider,
          keyName: encrypted.keyName,
          ciphertextBase64: encrypted.ciphertextBase64,
          aadVersion: encrypted.aadVersion,
          grantedScopes: params.grantedScopes,
          updatedAt: params.now,
          lastRefreshAt: params.now,
          revokedAt: null,
          sanitizedStatus: 'ok',
        },
        { merge: true },
      );
      return;
    }
    const doc: ProductGoogleCredentialDoc = {
      userId: params.userId,
      cipherProvider: encrypted.provider,
      keyName: encrypted.keyName,
      ciphertextBase64: encrypted.ciphertextBase64,
      aadVersion: encrypted.aadVersion,
      grantedScopes: params.grantedScopes,
      createdAt: params.now,
      updatedAt: params.now,
      revokedAt: null,
      lastRefreshAt: params.now,
      sanitizedStatus: 'ok',
    };
    await ref.set(doc);
  }

  async revokeForUser(userId: string, now: Date): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(userId).set({ revokedAt: now }, { merge: true });
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。 */
export class InMemoryGoogleCredentialRepository implements GoogleCredentialRepository {
  private readonly store = new Map<string, ProductGoogleCredentialDoc>();

  constructor(private readonly cipher: GoogleCredentialCipher) {}

  async getForUser(userId: string): Promise<{ refreshToken: string; grantedScopes: string[] } | null> {
    const doc = this.store.get(userId);
    if (!doc || doc.revokedAt !== null) return null;
    const refreshToken = await this.cipher.decrypt(
      { provider: doc.cipherProvider, keyName: doc.keyName, ciphertextBase64: doc.ciphertextBase64, aadVersion: doc.aadVersion },
      computeCredentialAad(userId),
    );
    return { refreshToken, grantedScopes: doc.grantedScopes };
  }

  async saveForUser(params: SaveCredentialParams): Promise<void> {
    const encrypted = await this.cipher.encrypt(params.refreshToken, computeCredentialAad(params.userId));
    this.store.set(params.userId, {
      userId: params.userId,
      cipherProvider: encrypted.provider,
      keyName: encrypted.keyName,
      ciphertextBase64: encrypted.ciphertextBase64,
      aadVersion: encrypted.aadVersion,
      grantedScopes: params.grantedScopes,
      createdAt: this.store.get(params.userId)?.createdAt ?? params.now,
      updatedAt: params.now,
      revokedAt: null,
      lastRefreshAt: params.now,
      sanitizedStatus: 'ok',
    });
  }

  async revokeForUser(userId: string, now: Date): Promise<void> {
    const existing = this.store.get(userId);
    if (!existing) return;
    this.store.set(userId, { ...existing, revokedAt: now });
  }
}
