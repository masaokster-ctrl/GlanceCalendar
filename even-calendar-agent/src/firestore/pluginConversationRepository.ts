import { Timestamp, type Firestore, type Transaction } from '@google-cloud/firestore';
import type { MissingField, PartialCandidate, PluginConversationStateDoc } from './models.js';

const COLLECTION = 'pluginConversationStates';
export const MAX_TURNS = 3;

export interface CreateConversationParams {
  conversationId: string;
  sessionHash: string;
  installIdHash: string;
  partialCandidate: PartialCandidate;
  missingField: MissingField;
  now: Date;
  expiresAt: Date;
}

export interface AcquireFollowupLeaseParams {
  conversationId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  now: Date;
}

export type AcquireFollowupLeaseResult =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'wrong_status'; doc: PluginConversationStateDoc }
  | { kind: 'max_turns_reached'; doc: PluginConversationStateDoc }
  | { kind: 'lease_active'; doc: PluginConversationStateDoc }
  | { kind: 'lease_acquired'; doc: PluginConversationStateDoc };

export interface RecordNextClarificationParams {
  conversationId: string;
  partialCandidate: PartialCandidate;
  missingField: MissingField;
  now: Date;
}

export interface PluginConversationRepository {
  create(params: CreateConversationParams): Promise<void>;
  get(conversationId: string): Promise<PluginConversationStateDoc | null>;
  /** 新規会話開始時、同一セッションの既存active(awaiting_clarification/analyzing_followup)を全てcancelledにする。 */
  cancelActiveForSession(sessionHash: string, now: Date): Promise<void>;
  acquireFollowupLease(params: AcquireFollowupLeaseParams): Promise<AcquireFollowupLeaseResult>;
  markCompleted(conversationId: string, now: Date): Promise<void>;
  markCancelled(conversationId: string, now: Date): Promise<void>;
  /** needs_clarificationが続く場合: turnCount+1でawaiting_clarificationへ戻す。TTLは延長しない。 */
  recordNextClarification(params: RecordNextClarificationParams): Promise<void>;
  /** Gemini呼び出し失敗等: turnCountを増やさずawaiting_clarificationへ戻す(リースのみ解除)。 */
  releaseLeaseBackToAwaiting(conversationId: string, now: Date): Promise<void>;
}

function normalizeDate(value: unknown): Date {
  if (value instanceof Timestamp) return value.toDate();
  return value as Date;
}

function normalizeNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return normalizeDate(value);
}

function normalizeDoc(doc: PluginConversationStateDoc): PluginConversationStateDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    updatedAt: normalizeDate(doc.updatedAt),
    expiresAt: normalizeDate(doc.expiresAt),
    completedAt: normalizeNullableDate(doc.completedAt),
    cancelledAt: normalizeNullableDate(doc.cancelledAt),
    leaseExpiresAt: normalizeNullableDate(doc.leaseExpiresAt),
  };
}

/** 新フィールド(dateLocal/endDateLocal/allDaySignal等)を持たない旧スキーマのドキュメントかどうか。TTLが
 * 短いため通常は起こらないが、デプロイ切り替え直後の在庫会話を安全側(期限切れ扱い→最初からやり直し)に
 * 倒すための互換チェック。endDateLocal/allDaySignalは終日/複数日対応で追加したフィールドのため、
 * dateLocalは存在するがこれらを欠く(全日対応より前に作成された)ドキュメントもレガシー扱いにする。 */
function isLegacyPartialCandidate(doc: PluginConversationStateDoc): boolean {
  return (
    typeof doc.partialCandidate.dateLocal === 'undefined' ||
    typeof doc.partialCandidate.endDateLocal === 'undefined' ||
    typeof doc.partialCandidate.allDaySignal === 'undefined'
  );
}

function computeLeaseResult(doc: PluginConversationStateDoc, params: AcquireFollowupLeaseParams): AcquireFollowupLeaseResult {
  if (isLegacyPartialCandidate(doc)) {
    return { kind: 'wrong_status', doc };
  }
  if (doc.status === 'awaiting_clarification' && doc.expiresAt.getTime() <= params.now.getTime()) {
    return { kind: 'expired' };
  }
  if (doc.status === 'completed' || doc.status === 'cancelled') {
    return { kind: 'wrong_status', doc };
  }
  if (doc.status === 'analyzing_followup') {
    const leaseStillActive = doc.leaseExpiresAt !== null && doc.leaseExpiresAt.getTime() > params.now.getTime();
    if (leaseStillActive) {
      return { kind: 'lease_active', doc };
    }
    // リースが期限切れなら再取得を試みる(下の turnCount チェックへ続く)
  }
  if (doc.turnCount >= MAX_TURNS) {
    return { kind: 'max_turns_reached', doc };
  }

  const updated: PluginConversationStateDoc = {
    ...doc,
    status: 'analyzing_followup',
    leaseOwner: params.leaseOwner,
    leaseExpiresAt: new Date(params.now.getTime() + params.leaseDurationMs),
    updatedAt: params.now,
  };
  return { kind: 'lease_acquired', doc: updated };
}

export class FirestorePluginConversationRepository implements PluginConversationRepository {
  constructor(private readonly firestore: Firestore) {}

  async create(params: CreateConversationParams): Promise<void> {
    const doc: PluginConversationStateDoc = {
      conversationId: params.conversationId,
      sessionHash: params.sessionHash,
      installIdHash: params.installIdHash,
      turnCount: 0,
      status: 'awaiting_clarification',
      partialCandidate: params.partialCandidate,
      missingField: params.missingField,
      clarificationQuestionCode: params.missingField,
      createdAt: params.now,
      updatedAt: params.now,
      expiresAt: params.expiresAt,
      completedAt: null,
      cancelledAt: null,
      lastRequestIdHash: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    await this.firestore.collection(COLLECTION).doc(params.conversationId).set(doc);
  }

  async get(conversationId: string): Promise<PluginConversationStateDoc | null> {
    const snapshot = await this.firestore.collection(COLLECTION).doc(conversationId).get();
    return snapshot.exists ? normalizeDoc(snapshot.data() as PluginConversationStateDoc) : null;
  }

  async cancelActiveForSession(sessionHash: string, now: Date): Promise<void> {
    const snapshot = await this.firestore
      .collection(COLLECTION)
      .where('sessionHash', '==', sessionHash)
      .where('status', 'in', ['awaiting_clarification', 'analyzing_followup'])
      .get();

    await Promise.all(
      snapshot.docs.map((docSnap) =>
        docSnap.ref.set({ status: 'cancelled', cancelledAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null }, { merge: true }),
      ),
    );
  }

  async acquireFollowupLease(params: AcquireFollowupLeaseParams): Promise<AcquireFollowupLeaseResult> {
    const ref = this.firestore.collection(COLLECTION).doc(params.conversationId);

    return this.firestore.runTransaction(async (tx: Transaction) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) {
        return { kind: 'not_found' } as const;
      }
      const doc = normalizeDoc(snapshot.data() as PluginConversationStateDoc);
      const result = computeLeaseResult(doc, params);

      if (result.kind === 'lease_acquired') {
        tx.set(ref, result.doc);
      }

      return result;
    });
  }

  async markCompleted(conversationId: string, now: Date): Promise<void> {
    await this.firestore
      .collection(COLLECTION)
      .doc(conversationId)
      .set({ status: 'completed', completedAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null }, { merge: true });
  }

  async markCancelled(conversationId: string, now: Date): Promise<void> {
    await this.firestore
      .collection(COLLECTION)
      .doc(conversationId)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null }, { merge: true });
  }

  async recordNextClarification(params: RecordNextClarificationParams): Promise<void> {
    const ref = this.firestore.collection(COLLECTION).doc(params.conversationId);
    await this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return;
      const doc = normalizeDoc(snapshot.data() as PluginConversationStateDoc);
      tx.set(
        ref,
        {
          status: 'awaiting_clarification',
          turnCount: doc.turnCount + 1,
          partialCandidate: params.partialCandidate,
          missingField: params.missingField,
          clarificationQuestionCode: params.missingField,
          updatedAt: params.now,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
        { merge: true },
      );
    });
  }

  async releaseLeaseBackToAwaiting(conversationId: string, now: Date): Promise<void> {
    await this.firestore
      .collection(COLLECTION)
      .doc(conversationId)
      .set({ status: 'awaiting_clarification', updatedAt: now, leaseOwner: null, leaseExpiresAt: null }, { merge: true });
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。 */
export class InMemoryPluginConversationRepository implements PluginConversationRepository {
  private readonly store = new Map<string, PluginConversationStateDoc>();

  async create(params: CreateConversationParams): Promise<void> {
    this.store.set(params.conversationId, {
      conversationId: params.conversationId,
      sessionHash: params.sessionHash,
      installIdHash: params.installIdHash,
      turnCount: 0,
      status: 'awaiting_clarification',
      partialCandidate: params.partialCandidate,
      missingField: params.missingField,
      clarificationQuestionCode: params.missingField,
      createdAt: params.now,
      updatedAt: params.now,
      expiresAt: params.expiresAt,
      completedAt: null,
      cancelledAt: null,
      lastRequestIdHash: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  async get(conversationId: string): Promise<PluginConversationStateDoc | null> {
    return this.store.get(conversationId) ?? null;
  }

  async cancelActiveForSession(sessionHash: string, now: Date): Promise<void> {
    for (const [id, doc] of this.store.entries()) {
      if (doc.sessionHash === sessionHash && (doc.status === 'awaiting_clarification' || doc.status === 'analyzing_followup')) {
        this.store.set(id, { ...doc, status: 'cancelled', cancelledAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null });
      }
    }
  }

  async acquireFollowupLease(params: AcquireFollowupLeaseParams): Promise<AcquireFollowupLeaseResult> {
    const doc = this.store.get(params.conversationId);
    if (!doc) {
      return { kind: 'not_found' };
    }
    const result = computeLeaseResult(doc, params);
    if (result.kind === 'lease_acquired') {
      this.store.set(params.conversationId, result.doc);
    }
    return result;
  }

  async markCompleted(conversationId: string, now: Date): Promise<void> {
    const existing = this.store.get(conversationId);
    if (!existing) return;
    this.store.set(conversationId, {
      ...existing,
      status: 'completed',
      completedAt: now,
      updatedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  async markCancelled(conversationId: string, now: Date): Promise<void> {
    const existing = this.store.get(conversationId);
    if (!existing) return;
    this.store.set(conversationId, {
      ...existing,
      status: 'cancelled',
      cancelledAt: now,
      updatedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  async recordNextClarification(params: RecordNextClarificationParams): Promise<void> {
    const existing = this.store.get(params.conversationId);
    if (!existing) return;
    this.store.set(params.conversationId, {
      ...existing,
      status: 'awaiting_clarification',
      turnCount: existing.turnCount + 1,
      partialCandidate: params.partialCandidate,
      missingField: params.missingField,
      clarificationQuestionCode: params.missingField,
      updatedAt: params.now,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  async releaseLeaseBackToAwaiting(conversationId: string, now: Date): Promise<void> {
    const existing = this.store.get(conversationId);
    if (!existing) return;
    this.store.set(conversationId, {
      ...existing,
      status: 'awaiting_clarification',
      updatedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /** テスト専用の内容検査ヘルパー。 */
  entriesForTest(): PluginConversationStateDoc[] {
    return [...this.store.values()];
  }
}
