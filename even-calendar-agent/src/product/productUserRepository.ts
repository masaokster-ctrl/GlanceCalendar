import type { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { normalizeDate, normalizeNullableDate } from '../firestore/firestoreDates.js';
import type { ProductUserDoc } from '../firestore/models.js';

export interface CreateProductUserParams {
  googleSubjectHash: string;
  googleEmailHash: string | null;
  now: Date;
  termsVersion?: string | null;
  privacyVersion?: string | null;
}

export interface ProductUserRepository {
  findBySubjectHash(googleSubjectHash: string): Promise<ProductUserDoc | null>;
  create(params: CreateProductUserParams): Promise<ProductUserDoc>;
  get(userId: string): Promise<ProductUserDoc | null>;
  touchLogin(userId: string, now: Date): Promise<void>;
}

function normalizeDoc(doc: ProductUserDoc): ProductUserDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    updatedAt: normalizeDate(doc.updatedAt),
    lastLoginAt: normalizeNullableDate(doc.lastLoginAt),
  };
}

const COLLECTION = 'productUsers';

export class FirestoreProductUserRepository implements ProductUserRepository {
  constructor(private readonly firestore: Firestore) {}

  async findBySubjectHash(googleSubjectHash: string): Promise<ProductUserDoc | null> {
    const snapshot = await this.firestore.collection(COLLECTION).where('googleSubjectHash', '==', googleSubjectHash).limit(1).get();
    if (snapshot.empty) return null;
    return normalizeDoc(snapshot.docs[0]!.data() as ProductUserDoc);
  }

  async create(params: CreateProductUserParams): Promise<ProductUserDoc> {
    const doc: ProductUserDoc = {
      userId: randomUUID(),
      googleSubjectHash: params.googleSubjectHash,
      googleEmailHash: params.googleEmailHash,
      status: 'active',
      createdAt: params.now,
      updatedAt: params.now,
      lastLoginAt: null,
      termsVersion: params.termsVersion ?? null,
      privacyVersion: params.privacyVersion ?? null,
    };
    await this.firestore.collection(COLLECTION).doc(doc.userId).set(doc);
    return doc;
  }

  async get(userId: string): Promise<ProductUserDoc | null> {
    const snapshot = await this.firestore.collection(COLLECTION).doc(userId).get();
    return snapshot.exists ? normalizeDoc(snapshot.data() as ProductUserDoc) : null;
  }

  async touchLogin(userId: string, now: Date): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(userId).set({ lastLoginAt: now, updatedAt: now }, { merge: true });
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。 */
export class InMemoryProductUserRepository implements ProductUserRepository {
  private readonly store = new Map<string, ProductUserDoc>();

  async findBySubjectHash(googleSubjectHash: string): Promise<ProductUserDoc | null> {
    for (const doc of this.store.values()) {
      if (doc.googleSubjectHash === googleSubjectHash) return doc;
    }
    return null;
  }

  async create(params: CreateProductUserParams): Promise<ProductUserDoc> {
    const doc: ProductUserDoc = {
      userId: randomUUID(),
      googleSubjectHash: params.googleSubjectHash,
      googleEmailHash: params.googleEmailHash,
      status: 'active',
      createdAt: params.now,
      updatedAt: params.now,
      lastLoginAt: null,
      termsVersion: params.termsVersion ?? null,
      privacyVersion: params.privacyVersion ?? null,
    };
    this.store.set(doc.userId, doc);
    return doc;
  }

  async get(userId: string): Promise<ProductUserDoc | null> {
    return this.store.get(userId) ?? null;
  }

  async touchLogin(userId: string, now: Date): Promise<void> {
    const existing = this.store.get(userId);
    if (!existing) return;
    this.store.set(userId, { ...existing, lastLoginAt: now, updatedAt: now });
  }
}
