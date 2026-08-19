import type { Firestore } from '@google-cloud/firestore';
import { normalizeDate, normalizeNullableDate } from '../firestore/firestoreDates.js';
import type { ProductInstallationDoc } from '../firestore/models.js';

export interface CreateInstallationParams {
  installationId: string;
  now: Date;
  appVersion: string | null;
  sdkVersion: string | null;
}

export interface ProductInstallationRepository {
  /** 既存installationがあればそのまま返す(冪等)。なければ新規作成する。 */
  getOrCreate(params: CreateInstallationParams): Promise<ProductInstallationDoc>;
  get(installationId: string): Promise<ProductInstallationDoc | null>;
  bindUser(installationId: string, userId: string, now: Date): Promise<void>;
  touchLastSeen(installationId: string, now: Date): Promise<void>;
  /** tokenVersionをインクリメントしstatus:revokedにする。既発行のdevice sessionを一括失効させる。 */
  revoke(installationId: string, now: Date): Promise<void>;
}

function normalizeDoc(doc: ProductInstallationDoc): ProductInstallationDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    pairedAt: normalizeNullableDate(doc.pairedAt),
    lastSeenAt: normalizeNullableDate(doc.lastSeenAt),
    revokedAt: normalizeNullableDate(doc.revokedAt),
  };
}

const COLLECTION = 'productInstallations';

export class FirestoreProductInstallationRepository implements ProductInstallationRepository {
  constructor(private readonly firestore: Firestore) {}

  async getOrCreate(params: CreateInstallationParams): Promise<ProductInstallationDoc> {
    const ref = this.firestore.collection(COLLECTION).doc(params.installationId);
    const snapshot = await ref.get();
    if (snapshot.exists) {
      return normalizeDoc(snapshot.data() as ProductInstallationDoc);
    }
    const doc: ProductInstallationDoc = {
      installationId: params.installationId,
      userId: null,
      status: 'active',
      createdAt: params.now,
      pairedAt: null,
      lastSeenAt: params.now,
      revokedAt: null,
      tokenVersion: 1,
      appVersion: params.appVersion,
      sdkVersion: params.sdkVersion,
    };
    await ref.set(doc);
    return doc;
  }

  async get(installationId: string): Promise<ProductInstallationDoc | null> {
    const snapshot = await this.firestore.collection(COLLECTION).doc(installationId).get();
    return snapshot.exists ? normalizeDoc(snapshot.data() as ProductInstallationDoc) : null;
  }

  async bindUser(installationId: string, userId: string, now: Date): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(installationId).set({ userId, pairedAt: now, lastSeenAt: now }, { merge: true });
  }

  async touchLastSeen(installationId: string, now: Date): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(installationId).set({ lastSeenAt: now }, { merge: true });
  }

  async revoke(installationId: string, now: Date): Promise<void> {
    const ref = this.firestore.collection(COLLECTION).doc(installationId);
    const snapshot = await ref.get();
    const current = snapshot.exists ? (snapshot.data() as ProductInstallationDoc).tokenVersion : 0;
    await ref.set({ status: 'revoked', revokedAt: now, tokenVersion: current + 1 }, { merge: true });
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。
 *  storeを外部から注入できるのは、ProductExchangeCoordinator(InMemory版)と同じMapを共有するため。 */
export class InMemoryProductInstallationRepository implements ProductInstallationRepository {
  constructor(private readonly store: Map<string, ProductInstallationDoc> = new Map()) {}

  async getOrCreate(params: CreateInstallationParams): Promise<ProductInstallationDoc> {
    const existing = this.store.get(params.installationId);
    if (existing) return existing;
    const doc: ProductInstallationDoc = {
      installationId: params.installationId,
      userId: null,
      status: 'active',
      createdAt: params.now,
      pairedAt: null,
      lastSeenAt: params.now,
      revokedAt: null,
      tokenVersion: 1,
      appVersion: params.appVersion,
      sdkVersion: params.sdkVersion,
    };
    this.store.set(params.installationId, doc);
    return doc;
  }

  async get(installationId: string): Promise<ProductInstallationDoc | null> {
    return this.store.get(installationId) ?? null;
  }

  async bindUser(installationId: string, userId: string, now: Date): Promise<void> {
    const existing = this.store.get(installationId);
    if (!existing) return;
    this.store.set(installationId, { ...existing, userId, pairedAt: now, lastSeenAt: now });
  }

  async touchLastSeen(installationId: string, now: Date): Promise<void> {
    const existing = this.store.get(installationId);
    if (!existing) return;
    this.store.set(installationId, { ...existing, lastSeenAt: now });
  }

  async revoke(installationId: string, now: Date): Promise<void> {
    const existing = this.store.get(installationId);
    if (!existing) return;
    this.store.set(installationId, { ...existing, status: 'revoked', revokedAt: now, tokenVersion: existing.tokenVersion + 1 });
  }
}
