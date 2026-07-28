import type { Firestore, Transaction } from '@google-cloud/firestore';
import type { ActionType, IdempotencyDoc } from './models.js';

export type LeaseResult =
  | { kind: 'completed'; doc: IdempotencyDoc }
  | { kind: 'processing'; doc: IdempotencyDoc }
  | { kind: 'lease-acquired'; doc: IdempotencyDoc };

export interface AcquireLeaseParams {
  operationId: string;
  actionType: ActionType;
  calendarId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  now: Date;
  expiresAt: Date;
}

export interface MarkCompletedParams {
  operationId: string;
  googleEventId: string;
  resultCode: string;
  now: Date;
}

export interface MarkFailedParams {
  operationId: string;
  sanitizedErrorCode: string;
  now: Date;
}

export interface IdempotencyRepository {
  /**
   * completedならそのまま結果を返し、processingかつlease有効なら新規実行しない。
   * それ以外(未作成/pending/failed/lease期限切れ)は新しいleaseを取得して返す。
   * Calendar APIの呼び出しはこの関数の外側で行うこと。
   */
  acquireLeaseOrGetStatus(params: AcquireLeaseParams): Promise<LeaseResult>;
  markCompleted(params: MarkCompletedParams): Promise<void>;
  markFailed(params: MarkFailedParams): Promise<void>;
  get(operationId: string): Promise<IdempotencyDoc | null>;
}

const COLLECTION = 'idempotency';

function computeNextDoc(
  existing: IdempotencyDoc | null,
  params: AcquireLeaseParams,
): { doc: IdempotencyDoc; kind: LeaseResult['kind'] } {
  if (existing) {
    if (existing.status === 'completed') {
      return { doc: existing, kind: 'completed' };
    }

    const leaseStillActive =
      existing.status === 'processing' &&
      existing.leaseExpiresAt !== null &&
      existing.leaseExpiresAt.getTime() > params.now.getTime();

    if (leaseStillActive) {
      return { doc: existing, kind: 'processing' };
    }

    const updated: IdempotencyDoc = {
      ...existing,
      status: 'processing',
      leaseOwner: params.leaseOwner,
      leaseExpiresAt: new Date(params.now.getTime() + params.leaseDurationMs),
      attemptCount: existing.attemptCount + 1,
      updatedAt: params.now,
    };
    return { doc: updated, kind: 'lease-acquired' };
  }

  const created: IdempotencyDoc = {
    operationId: params.operationId,
    actionType: params.actionType,
    status: 'processing',
    calendarId: params.calendarId,
    googleEventId: null,
    leaseOwner: params.leaseOwner,
    leaseExpiresAt: new Date(params.now.getTime() + params.leaseDurationMs),
    attemptCount: 1,
    resultCode: null,
    lastErrorCode: null,
    createdAt: params.now,
    updatedAt: params.now,
    completedAt: null,
    expiresAt: params.expiresAt,
  };
  return { doc: created, kind: 'lease-acquired' };
}

export class FirestoreIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly firestore: Firestore) {}

  async acquireLeaseOrGetStatus(params: AcquireLeaseParams): Promise<LeaseResult> {
    return this.firestore.runTransaction(async (tx: Transaction) => {
      const ref = this.firestore.collection(COLLECTION).doc(params.operationId);
      const snapshot = await tx.get(ref);
      const existing = snapshot.exists ? (snapshot.data() as IdempotencyDoc) : null;
      const { doc, kind } = computeNextDoc(existing, params);

      if (kind === 'lease-acquired') {
        tx.set(ref, doc);
      }

      return { kind, doc } as LeaseResult;
    });
  }

  async markCompleted(params: MarkCompletedParams): Promise<void> {
    const ref = this.firestore.collection(COLLECTION).doc(params.operationId);
    await ref.set(
      {
        status: 'completed',
        googleEventId: params.googleEventId,
        resultCode: params.resultCode,
        completedAt: params.now,
        updatedAt: params.now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      { merge: true },
    );
  }

  async markFailed(params: MarkFailedParams): Promise<void> {
    const ref = this.firestore.collection(COLLECTION).doc(params.operationId);
    await ref.set(
      {
        status: 'failed',
        lastErrorCode: params.sanitizedErrorCode,
        updatedAt: params.now,
      },
      { merge: true },
    );
  }

  async get(operationId: string): Promise<IdempotencyDoc | null> {
    const snapshot = await this.firestore.collection(COLLECTION).doc(operationId).get();
    return snapshot.exists ? (snapshot.data() as IdempotencyDoc) : null;
  }
}

/**
 * テスト・ローカル疎通確認用のインメモリ実装。
 * awaitを挟まない同期的な読み取り→書き込みにより、Firestoreトランザクションと同様に
 * 同時アクセス時でも1件だけがleaseを取得する挙動を単一プロセス内で再現する。
 */
export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  private readonly store = new Map<string, IdempotencyDoc>();

  async acquireLeaseOrGetStatus(params: AcquireLeaseParams): Promise<LeaseResult> {
    const existing = this.store.get(params.operationId) ?? null;
    const { doc, kind } = computeNextDoc(existing, params);

    if (kind === 'lease-acquired') {
      this.store.set(params.operationId, doc);
    }

    return { kind, doc };
  }

  async markCompleted(params: MarkCompletedParams): Promise<void> {
    const existing = this.store.get(params.operationId);
    if (!existing) {
      return;
    }
    this.store.set(params.operationId, {
      ...existing,
      status: 'completed',
      googleEventId: params.googleEventId,
      resultCode: params.resultCode,
      completedAt: params.now,
      updatedAt: params.now,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  async markFailed(params: MarkFailedParams): Promise<void> {
    const existing = this.store.get(params.operationId);
    if (!existing) {
      return;
    }
    this.store.set(params.operationId, {
      ...existing,
      status: 'failed',
      lastErrorCode: params.sanitizedErrorCode,
      updatedAt: params.now,
    });
  }

  async get(operationId: string): Promise<IdempotencyDoc | null> {
    return this.store.get(operationId) ?? null;
  }
}
