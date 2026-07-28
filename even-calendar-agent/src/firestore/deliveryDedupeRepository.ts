import type { Firestore } from '@google-cloud/firestore';
import type { ActionType, DeliveryDedupeDoc } from './models.js';

export interface RecordDeliveryParams {
  deliveryKey: string;
  requestFingerprint: string;
  operationId: string | null;
  actionType: ActionType | null;
  now: Date;
  expiresAt: Date;
}

export interface DeliveryDedupeRepository {
  /**
   * deliveryKeyを記録し、記録前に既に同じkeyが存在していたか(=重複配送)を返す。
   * 会話本文・Authorization値・Bearer Token・assistant回答本文は保存しない。
   */
  recordAndCheckDuplicate(params: RecordDeliveryParams): Promise<boolean>;
}

const COLLECTION = 'deliveryDedupe';

export class FirestoreDeliveryDedupeRepository implements DeliveryDedupeRepository {
  constructor(private readonly firestore: Firestore) {}

  async recordAndCheckDuplicate(params: RecordDeliveryParams): Promise<boolean> {
    const ref = this.firestore.collection(COLLECTION).doc(params.deliveryKey);

    return this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const alreadyExists = snapshot.exists;

      if (!alreadyExists) {
        const doc: DeliveryDedupeDoc = {
          deliveryKey: params.deliveryKey,
          requestFingerprint: params.requestFingerprint,
          operationId: params.operationId,
          actionType: params.actionType,
          createdAt: params.now,
          expiresAt: params.expiresAt,
        };
        tx.set(ref, doc);
      }

      return alreadyExists;
    });
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。 */
export class InMemoryDeliveryDedupeRepository implements DeliveryDedupeRepository {
  private readonly store = new Map<string, DeliveryDedupeDoc>();

  async recordAndCheckDuplicate(params: RecordDeliveryParams): Promise<boolean> {
    const alreadyExists = this.store.has(params.deliveryKey);

    if (!alreadyExists) {
      this.store.set(params.deliveryKey, {
        deliveryKey: params.deliveryKey,
        requestFingerprint: params.requestFingerprint,
        operationId: params.operationId,
        actionType: params.actionType,
        createdAt: params.now,
        expiresAt: params.expiresAt,
      });
    }

    return alreadyExists;
  }
}
