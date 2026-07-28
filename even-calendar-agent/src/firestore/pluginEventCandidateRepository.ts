import { Timestamp, type Firestore, type Transaction } from '@google-cloud/firestore';
import type { PluginEventCandidateDoc, PluginEventCandidateTiming } from './models.js';

export interface CreateCandidateParamsBase {
  candidateId: string;
  sessionHash: string;
  installIdHash: string;
  title: string;
  timeZone: string;
  now: Date;
  expiresAt: Date;
  analysisRequestIdHash: string;
}

/**
 * PluginEventCandidateTimingと同じ判別可能ユニオン。allDay:falseならstartLocal/endLocalが必須で
 * startDate/endDateExclusiveはnull固定、allDay:trueならstartDate/endDateExclusiveが必須で
 * startLocal/endLocalはnull固定。呼び出し側でオプショナル省略による曖昧さを許さない。
 */
export type CreateCandidateParams = CreateCandidateParamsBase & PluginEventCandidateTiming;

export interface AcquireCandidateLeaseParams {
  candidateId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  now: Date;
}

export type AcquireCandidateLeaseResult =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'already_completed'; doc: PluginEventCandidateDoc }
  | { kind: 'already_failed'; doc: PluginEventCandidateDoc }
  | { kind: 'lease_active'; doc: PluginEventCandidateDoc }
  | { kind: 'lease_acquired'; doc: PluginEventCandidateDoc };

export interface PluginEventCandidateRepository {
  create(params: CreateCandidateParams): Promise<void>;
  get(candidateId: string): Promise<PluginEventCandidateDoc | null>;
  /** pending→creatingのlease取得をFirestoreトランザクションで行う。Calendar APIはこの外側で呼ぶこと。 */
  acquireLease(params: AcquireCandidateLeaseParams): Promise<AcquireCandidateLeaseResult>;
  markCompleted(candidateId: string, googleEventId: string, now: Date): Promise<void>;
  markFailed(candidateId: string, sanitizedErrorCode: string, now: Date): Promise<void>;
}

const COLLECTION = 'pluginEventCandidates';

function normalizeDate(value: unknown): Date {
  if (value instanceof Timestamp) return value.toDate();
  return value as Date;
}

function normalizeNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return normalizeDate(value);
}

function normalizeDoc(doc: PluginEventCandidateDoc): PluginEventCandidateDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    expiresAt: normalizeDate(doc.expiresAt),
    consumedAt: normalizeNullableDate(doc.consumedAt),
    leaseExpiresAt: normalizeNullableDate(doc.leaseExpiresAt),
  };
}

/**
 * CreateCandidateParamsのtiming部分をPluginEventCandidateTimingへ変換する。TypeScript上は
 * allDayによる分岐で各フィールドが必須/null固定になっているため`?? null`は型上到達不能に見えるが、
 * 型チェックを経由しない呼び出し(素のJSオブジェクトリテラルでフィールドが省略された場合)でも
 * Firestoreの「4フィールド常在・null埋め」という不変条件を守るための実行時防御であり、意図的に残す。
 */
function buildTiming(params: CreateCandidateParams): PluginEventCandidateTiming {
  const timing = params.allDay
    ? {
        allDay: true,
        startLocal: null,
        endLocal: null,
        startDate: params.startDate ?? null,
        endDateExclusive: params.endDateExclusive ?? null,
      }
    : {
        allDay: false,
        startLocal: params.startLocal ?? null,
        endLocal: params.endLocal ?? null,
        startDate: null,
        endDateExclusive: null,
      };
  return timing as PluginEventCandidateTiming;
}

function buildNewDoc(params: CreateCandidateParams): PluginEventCandidateDoc {
  return {
    candidateId: params.candidateId,
    sessionHash: params.sessionHash,
    installIdHash: params.installIdHash,
    title: params.title,
    timeZone: params.timeZone,
    status: 'pending',
    createdAt: params.now,
    expiresAt: params.expiresAt,
    consumedAt: null,
    analysisRequestIdHash: params.analysisRequestIdHash,
    operationId: null,
    googleEventId: null,
    sanitizedErrorCode: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    ...buildTiming(params),
  };
}

function computeLeaseResult(doc: PluginEventCandidateDoc, params: AcquireCandidateLeaseParams): AcquireCandidateLeaseResult {
  if (doc.status === 'pending' && doc.expiresAt.getTime() <= params.now.getTime()) {
    return { kind: 'expired' };
  }
  if (doc.status === 'completed') {
    return { kind: 'already_completed', doc };
  }
  if (doc.status === 'failed') {
    return { kind: 'already_failed', doc };
  }
  if (doc.status === 'creating') {
    const leaseStillActive = doc.leaseExpiresAt !== null && doc.leaseExpiresAt.getTime() > params.now.getTime();
    if (leaseStillActive) {
      return { kind: 'lease_active', doc };
    }
  }

  const updated: PluginEventCandidateDoc = {
    ...doc,
    status: 'creating',
    leaseOwner: params.leaseOwner,
    leaseExpiresAt: new Date(params.now.getTime() + params.leaseDurationMs),
  };
  return { kind: 'lease_acquired', doc: updated };
}

export class FirestorePluginEventCandidateRepository implements PluginEventCandidateRepository {
  constructor(private readonly firestore: Firestore) {}

  async create(params: CreateCandidateParams): Promise<void> {
    const doc = buildNewDoc(params);
    await this.firestore.collection(COLLECTION).doc(params.candidateId).set(doc);
  }

  async get(candidateId: string): Promise<PluginEventCandidateDoc | null> {
    const snapshot = await this.firestore.collection(COLLECTION).doc(candidateId).get();
    return snapshot.exists ? normalizeDoc(snapshot.data() as PluginEventCandidateDoc) : null;
  }

  async acquireLease(params: AcquireCandidateLeaseParams): Promise<AcquireCandidateLeaseResult> {
    const ref = this.firestore.collection(COLLECTION).doc(params.candidateId);

    return this.firestore.runTransaction(async (tx: Transaction) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) {
        return { kind: 'not_found' } as const;
      }
      const doc = normalizeDoc(snapshot.data() as PluginEventCandidateDoc);
      const result = computeLeaseResult(doc, params);

      if (result.kind === 'lease_acquired') {
        tx.set(ref, result.doc);
      }

      return result;
    });
  }

  async markCompleted(candidateId: string, googleEventId: string, now: Date): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(candidateId).set(
      {
        status: 'completed',
        googleEventId,
        consumedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      { merge: true },
    );
  }

  async markFailed(candidateId: string, sanitizedErrorCode: string, now: Date): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(candidateId).set(
      {
        status: 'failed',
        sanitizedErrorCode,
        consumedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      { merge: true },
    );
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。 */
export class InMemoryPluginEventCandidateRepository implements PluginEventCandidateRepository {
  private readonly store = new Map<string, PluginEventCandidateDoc>();

  async create(params: CreateCandidateParams): Promise<void> {
    this.store.set(params.candidateId, buildNewDoc(params));
  }

  async get(candidateId: string): Promise<PluginEventCandidateDoc | null> {
    return this.store.get(candidateId) ?? null;
  }

  async acquireLease(params: AcquireCandidateLeaseParams): Promise<AcquireCandidateLeaseResult> {
    const doc = this.store.get(params.candidateId);
    if (!doc) {
      return { kind: 'not_found' };
    }
    const result = computeLeaseResult(doc, params);
    if (result.kind === 'lease_acquired') {
      this.store.set(params.candidateId, result.doc);
    }
    return result;
  }

  async markCompleted(candidateId: string, googleEventId: string, now: Date): Promise<void> {
    const existing = this.store.get(candidateId);
    if (!existing) return;
    this.store.set(candidateId, {
      ...existing,
      status: 'completed',
      googleEventId,
      consumedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  async markFailed(candidateId: string, sanitizedErrorCode: string, now: Date): Promise<void> {
    const existing = this.store.get(candidateId);
    if (!existing) return;
    this.store.set(candidateId, {
      ...existing,
      status: 'failed',
      sanitizedErrorCode,
      consumedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /** テスト専用の内容検査ヘルパー。保存されている候補の一覧を返す。 */
  entriesForTest(): PluginEventCandidateDoc[] {
    return [...this.store.values()];
  }
}
