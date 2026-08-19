import type { Firestore } from '@google-cloud/firestore';
import { normalizeDate, normalizeNullableDate } from '../firestore/firestoreDates.js';
import type { ProductPairingSessionDoc } from '../firestore/models.js';

export interface CreatePairingParams {
  pairingId: string;
  userCodeHash: string;
  installationIdHash: string;
  now: Date;
  expiresAt: Date;
}

export interface ProductPairingRepository {
  create(params: CreatePairingParams): Promise<void>;
  getById(pairingId: string): Promise<ProductPairingSessionDoc | null>;
  findActiveByInstallationHash(installationIdHash: string, now: Date): Promise<ProductPairingSessionDoc | null>;
  findPendingByUserCodeHash(userCodeHash: string, now: Date): Promise<ProductPairingSessionDoc | null>;
  cancelActiveForInstallation(installationIdHash: string, now: Date): Promise<void>;
  markOAuthInProgress(pairingId: string): Promise<void>;
  markApproved(pairingId: string, userId: string, now: Date): Promise<void>;
  // exchange(approved→exchanged遷移・credential発行)はProductExchangeCoordinatorが専任で行う
  // (pairing doc単独のtransactionではpluginSessions/productDeviceRefreshTokens/productInstallations
  // とのatomic性を保証できないため、このRepositoryにはメソッドを置かない)。
  markFailed(pairingId: string, sanitizedErrorCode: string, now: Date): Promise<void>;
  markCancelled(pairingId: string, now: Date): Promise<void>;
  recordPollAttempt(pairingId: string, now: Date): Promise<void>;
}

const ACTIVE_STATUSES = ['pending', 'oauth_in_progress'] as const;

function normalizeDoc(doc: ProductPairingSessionDoc): ProductPairingSessionDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    expiresAt: normalizeDate(doc.expiresAt),
    approvedAt: normalizeNullableDate(doc.approvedAt),
    exchangedAt: normalizeNullableDate(doc.exchangedAt),
    lastPollAt: normalizeNullableDate(doc.lastPollAt),
  };
}

const COLLECTION = 'productPairingSessions';

export class FirestoreProductPairingRepository implements ProductPairingRepository {
  constructor(private readonly firestore: Firestore) {}

  async create(params: CreatePairingParams): Promise<void> {
    const doc: ProductPairingSessionDoc = {
      pairingId: params.pairingId,
      userCodeHash: params.userCodeHash,
      installationIdHash: params.installationIdHash,
      status: 'pending',
      createdAt: params.now,
      expiresAt: params.expiresAt,
      approvedAt: null,
      exchangedAt: null,
      userId: null,
      attemptCount: 0,
      lastPollAt: null,
      sanitizedErrorCode: null,
      exchangeAccessTokenHash: null,
      exchangeRefreshTokenHash: null,
    };
    await this.firestore.collection(COLLECTION).doc(params.pairingId).set(doc);
  }

  async getById(pairingId: string): Promise<ProductPairingSessionDoc | null> {
    const snapshot = await this.firestore.collection(COLLECTION).doc(pairingId).get();
    return snapshot.exists ? normalizeDoc(snapshot.data() as ProductPairingSessionDoc) : null;
  }

  async findActiveByInstallationHash(installationIdHash: string, now: Date): Promise<ProductPairingSessionDoc | null> {
    const snapshot = await this.firestore
      .collection(COLLECTION)
      .where('installationIdHash', '==', installationIdHash)
      .where('status', 'in', [...ACTIVE_STATUSES])
      .get();
    for (const docSnap of snapshot.docs) {
      const doc = normalizeDoc(docSnap.data() as ProductPairingSessionDoc);
      if (doc.expiresAt.getTime() > now.getTime()) return doc;
    }
    return null;
  }

  async findPendingByUserCodeHash(userCodeHash: string, now: Date): Promise<ProductPairingSessionDoc | null> {
    const snapshot = await this.firestore
      .collection(COLLECTION)
      .where('userCodeHash', '==', userCodeHash)
      .where('status', '==', 'pending')
      .get();
    for (const docSnap of snapshot.docs) {
      const doc = normalizeDoc(docSnap.data() as ProductPairingSessionDoc);
      if (doc.expiresAt.getTime() > now.getTime()) return doc;
    }
    return null;
  }

  async cancelActiveForInstallation(installationIdHash: string, now: Date): Promise<void> {
    const snapshot = await this.firestore
      .collection(COLLECTION)
      .where('installationIdHash', '==', installationIdHash)
      .where('status', 'in', [...ACTIVE_STATUSES])
      .get();
    await Promise.all(snapshot.docs.map((docSnap) => docSnap.ref.set({ status: 'cancelled' }, { merge: true })));
    void now;
  }

  async markOAuthInProgress(pairingId: string): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(pairingId).set({ status: 'oauth_in_progress' }, { merge: true });
  }

  async markApproved(pairingId: string, userId: string, now: Date): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(pairingId).set({ status: 'approved', userId, approvedAt: now }, { merge: true });
  }

  async markFailed(pairingId: string, sanitizedErrorCode: string, now: Date): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(pairingId).set({ status: 'failed', sanitizedErrorCode }, { merge: true });
    void now;
  }

  async markCancelled(pairingId: string, now: Date): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(pairingId).set({ status: 'cancelled' }, { merge: true });
    void now;
  }

  async recordPollAttempt(pairingId: string, now: Date): Promise<void> {
    const ref = this.firestore.collection(COLLECTION).doc(pairingId);
    const snapshot = await ref.get();
    const current = snapshot.exists ? (snapshot.data() as ProductPairingSessionDoc).attemptCount : 0;
    await ref.set({ attemptCount: current + 1, lastPollAt: now }, { merge: true });
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。
 *  storeを外部から注入できるようにしているのは、ProductExchangeCoordinator(InMemory版)と
 *  同じMapを共有し、exchange関連の統合テストで一貫した状態を検証できるようにするため。 */
export class InMemoryProductPairingRepository implements ProductPairingRepository {
  constructor(private readonly store: Map<string, ProductPairingSessionDoc> = new Map()) {}

  async create(params: CreatePairingParams): Promise<void> {
    this.store.set(params.pairingId, {
      pairingId: params.pairingId,
      userCodeHash: params.userCodeHash,
      installationIdHash: params.installationIdHash,
      status: 'pending',
      createdAt: params.now,
      expiresAt: params.expiresAt,
      approvedAt: null,
      exchangedAt: null,
      userId: null,
      attemptCount: 0,
      lastPollAt: null,
      sanitizedErrorCode: null,
      exchangeAccessTokenHash: null,
      exchangeRefreshTokenHash: null,
    });
  }

  async getById(pairingId: string): Promise<ProductPairingSessionDoc | null> {
    return this.store.get(pairingId) ?? null;
  }

  async findActiveByInstallationHash(installationIdHash: string, now: Date): Promise<ProductPairingSessionDoc | null> {
    for (const doc of this.store.values()) {
      if (
        doc.installationIdHash === installationIdHash &&
        (ACTIVE_STATUSES as readonly string[]).includes(doc.status) &&
        doc.expiresAt.getTime() > now.getTime()
      ) {
        return doc;
      }
    }
    return null;
  }

  async findPendingByUserCodeHash(userCodeHash: string, now: Date): Promise<ProductPairingSessionDoc | null> {
    for (const doc of this.store.values()) {
      if (doc.userCodeHash === userCodeHash && doc.status === 'pending' && doc.expiresAt.getTime() > now.getTime()) {
        return doc;
      }
    }
    return null;
  }

  async cancelActiveForInstallation(installationIdHash: string, _now: Date): Promise<void> {
    for (const [id, doc] of this.store.entries()) {
      if (doc.installationIdHash === installationIdHash && (ACTIVE_STATUSES as readonly string[]).includes(doc.status)) {
        this.store.set(id, { ...doc, status: 'cancelled' });
      }
    }
  }

  async markOAuthInProgress(pairingId: string): Promise<void> {
    const doc = this.store.get(pairingId);
    if (!doc) return;
    this.store.set(pairingId, { ...doc, status: 'oauth_in_progress' });
  }

  async markApproved(pairingId: string, userId: string, now: Date): Promise<void> {
    const doc = this.store.get(pairingId);
    if (!doc) return;
    this.store.set(pairingId, { ...doc, status: 'approved', userId, approvedAt: now });
  }

  async markFailed(pairingId: string, sanitizedErrorCode: string, _now: Date): Promise<void> {
    const doc = this.store.get(pairingId);
    if (!doc) return;
    this.store.set(pairingId, { ...doc, status: 'failed', sanitizedErrorCode });
  }

  async markCancelled(pairingId: string, _now: Date): Promise<void> {
    const doc = this.store.get(pairingId);
    if (!doc) return;
    this.store.set(pairingId, { ...doc, status: 'cancelled' });
  }

  async recordPollAttempt(pairingId: string, now: Date): Promise<void> {
    const doc = this.store.get(pairingId);
    if (!doc) return;
    this.store.set(pairingId, { ...doc, attemptCount: doc.attemptCount + 1, lastPollAt: now });
  }
}
