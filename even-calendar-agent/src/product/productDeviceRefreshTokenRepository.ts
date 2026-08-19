import type { Firestore } from '@google-cloud/firestore';
import { normalizeDate, normalizeNullableDate } from '../firestore/firestoreDates.js';
import type { ProductDeviceRefreshTokenDoc } from '../firestore/models.js';

export interface CreateRefreshTokenParams {
  refreshTokenHash: string;
  installationId: string;
  userId: string;
  familyId: string;
  generation: number;
  now: Date;
  expiresAt: Date;
}

export type RotateResult =
  | { kind: 'rotated' }
  | { kind: 'reuse_detected'; familyId: string }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'revoked' };

export interface ProductDeviceRefreshTokenRepository {
  create(params: CreateRefreshTokenParams): Promise<void>;
  getByHash(refreshTokenHash: string): Promise<ProductDeviceRefreshTokenDoc | null>;
  /**
   * oldHashを消費し、newHashを同familyの次generationとして発行する。oldHashが既にrotatedOrRevoked
   * (=再利用)であればreuse_detectedを返し、呼び出し側はfamily全体をrevokeすべきシグナルとする。
   */
  rotate(oldHash: string, newParams: CreateRefreshTokenParams): Promise<RotateResult>;
  revokeFamily(familyId: string, now: Date): Promise<void>;
}

function normalizeDoc(doc: ProductDeviceRefreshTokenDoc): ProductDeviceRefreshTokenDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    expiresAt: normalizeDate(doc.expiresAt),
    rotatedAt: normalizeNullableDate(doc.rotatedAt),
    revokedAt: normalizeNullableDate(doc.revokedAt),
  };
}

const COLLECTION = 'productDeviceRefreshTokens';

function buildDoc(params: CreateRefreshTokenParams): ProductDeviceRefreshTokenDoc {
  return {
    refreshTokenHash: params.refreshTokenHash,
    installationId: params.installationId,
    userId: params.userId,
    familyId: params.familyId,
    generation: params.generation,
    createdAt: params.now,
    expiresAt: params.expiresAt,
    rotatedAt: null,
    revokedAt: null,
    replacedByHash: null,
    reuseDetectedAt: null,
  };
}

export class FirestoreProductDeviceRefreshTokenRepository implements ProductDeviceRefreshTokenRepository {
  constructor(private readonly firestore: Firestore) {}

  async create(params: CreateRefreshTokenParams): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(params.refreshTokenHash).set(buildDoc(params));
  }

  async getByHash(refreshTokenHash: string): Promise<ProductDeviceRefreshTokenDoc | null> {
    const snapshot = await this.firestore.collection(COLLECTION).doc(refreshTokenHash).get();
    return snapshot.exists ? normalizeDoc(snapshot.data() as ProductDeviceRefreshTokenDoc) : null;
  }

  async rotate(oldHash: string, newParams: CreateRefreshTokenParams): Promise<RotateResult> {
    const oldRef = this.firestore.collection(COLLECTION).doc(oldHash);
    const oldSnapshot = await oldRef.get();
    if (!oldSnapshot.exists) return { kind: 'not_found' };
    const oldDoc = normalizeDoc(oldSnapshot.data() as ProductDeviceRefreshTokenDoc);
    if (oldDoc.revokedAt !== null) return { kind: 'revoked' };
    if (oldDoc.expiresAt.getTime() <= newParams.now.getTime()) return { kind: 'expired' };
    if (oldDoc.rotatedAt !== null) {
      // 既に一度rotateされたはずのtokenが再度使われた = reuse。familyを危険とみなす。
      return { kind: 'reuse_detected', familyId: oldDoc.familyId };
    }

    const newDoc = buildDoc(newParams);
    await this.firestore.collection(COLLECTION).doc(newParams.refreshTokenHash).set(newDoc);
    await oldRef.set({ rotatedAt: newParams.now, replacedByHash: newParams.refreshTokenHash }, { merge: true });
    return { kind: 'rotated' };
  }

  async revokeFamily(familyId: string, now: Date): Promise<void> {
    const snapshot = await this.firestore.collection(COLLECTION).where('familyId', '==', familyId).get();
    await Promise.all(snapshot.docs.map((docSnap) => docSnap.ref.set({ revokedAt: now }, { merge: true })));
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。
 *  storeを外部から注入できるのは、ProductExchangeCoordinator(InMemory版)と同じMapを共有するため。 */
export class InMemoryProductDeviceRefreshTokenRepository implements ProductDeviceRefreshTokenRepository {
  constructor(private readonly store: Map<string, ProductDeviceRefreshTokenDoc> = new Map()) {}

  async create(params: CreateRefreshTokenParams): Promise<void> {
    this.store.set(params.refreshTokenHash, buildDoc(params));
  }

  async getByHash(refreshTokenHash: string): Promise<ProductDeviceRefreshTokenDoc | null> {
    return this.store.get(refreshTokenHash) ?? null;
  }

  async rotate(oldHash: string, newParams: CreateRefreshTokenParams): Promise<RotateResult> {
    const oldDoc = this.store.get(oldHash);
    if (!oldDoc) return { kind: 'not_found' };
    if (oldDoc.revokedAt !== null) return { kind: 'revoked' };
    if (oldDoc.expiresAt.getTime() <= newParams.now.getTime()) return { kind: 'expired' };
    if (oldDoc.rotatedAt !== null) {
      return { kind: 'reuse_detected', familyId: oldDoc.familyId };
    }
    const newDoc = buildDoc(newParams);
    this.store.set(newParams.refreshTokenHash, newDoc);
    this.store.set(oldHash, { ...oldDoc, rotatedAt: newParams.now, replacedByHash: newParams.refreshTokenHash });
    return { kind: 'rotated' };
  }

  async revokeFamily(familyId: string, now: Date): Promise<void> {
    for (const [hash, doc] of this.store.entries()) {
      if (doc.familyId === familyId) {
        this.store.set(hash, { ...doc, revokedAt: now });
      }
    }
  }
}
