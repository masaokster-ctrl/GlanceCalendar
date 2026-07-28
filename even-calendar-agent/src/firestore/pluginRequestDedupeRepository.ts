import type { Firestore, Transaction } from '@google-cloud/firestore';
import type { PluginRequestDedupeDoc, PluginRequestDedupeStatus } from './models.js';

export interface AcquireRequestParams {
  requestKeyHash: string;
  now: Date;
  expiresAt: Date;
}

export type AcquireRequestResult = { kind: 'acquired' } | { kind: 'duplicate' };

export interface PluginRequestDedupeRepository {
  /** 未処理ならprocessingで新規作成しacquiredを返す。既に存在すればduplicateを返す(状態を問わない)。 */
  acquire(params: AcquireRequestParams): Promise<AcquireRequestResult>;
  markStatus(requestKeyHash: string, status: PluginRequestDedupeStatus, now: Date): Promise<void>;
}

const COLLECTION = 'pluginAnalyzeRequests';

export class FirestorePluginRequestDedupeRepository implements PluginRequestDedupeRepository {
  constructor(private readonly firestore: Firestore) {}

  async acquire(params: AcquireRequestParams): Promise<AcquireRequestResult> {
    const ref = this.firestore.collection(COLLECTION).doc(params.requestKeyHash);

    return this.firestore.runTransaction(async (tx: Transaction) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        return { kind: 'duplicate' } as const;
      }
      const doc: PluginRequestDedupeDoc = {
        requestKeyHash: params.requestKeyHash,
        status: 'processing',
        createdAt: params.now,
        updatedAt: params.now,
        expiresAt: params.expiresAt,
      };
      tx.set(ref, doc);
      return { kind: 'acquired' } as const;
    });
  }

  async markStatus(requestKeyHash: string, status: PluginRequestDedupeStatus, now: Date): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(requestKeyHash).set({ status, updatedAt: now }, { merge: true });
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。 */
export class InMemoryPluginRequestDedupeRepository implements PluginRequestDedupeRepository {
  private readonly store = new Map<string, PluginRequestDedupeDoc>();

  async acquire(params: AcquireRequestParams): Promise<AcquireRequestResult> {
    if (this.store.has(params.requestKeyHash)) {
      return { kind: 'duplicate' };
    }
    this.store.set(params.requestKeyHash, {
      requestKeyHash: params.requestKeyHash,
      status: 'processing',
      createdAt: params.now,
      updatedAt: params.now,
      expiresAt: params.expiresAt,
    });
    return { kind: 'acquired' };
  }

  async markStatus(requestKeyHash: string, status: PluginRequestDedupeStatus, now: Date): Promise<void> {
    const existing = this.store.get(requestKeyHash);
    if (!existing) return;
    this.store.set(requestKeyHash, { ...existing, status, updatedAt: now });
  }

  /** テスト専用の内容検査ヘルパー。保存されているのが requestKeyHash/status/timestamps のみであることを確認するため。 */
  entries(): PluginRequestDedupeDoc[] {
    return [...this.store.values()];
  }
}
