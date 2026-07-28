import { Timestamp, type Firestore } from '@google-cloud/firestore';
import type { PluginSessionDoc } from './models.js';

/**
 * Firestoreは書き込んだDate値をTimestampとして返す(getTime()を持たない)ため、
 * 読み取り側の型(Date)と実際のランタイム型を一致させてから返す。
 */
function normalizeDate(value: unknown): Date {
  if (value instanceof Timestamp) return value.toDate();
  return value as Date;
}

function normalizeNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return normalizeDate(value);
}

function normalizeDoc(doc: PluginSessionDoc): PluginSessionDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    expiresAt: normalizeDate(doc.expiresAt),
    revokedAt: normalizeNullableDate(doc.revokedAt),
  };
}

export interface CreateSessionParams {
  tokenHash: string;
  installId: string;
  scope: string[];
  now: Date;
  expiresAt: Date;
  tokenType?: 'dev' | 'device';
  userId?: string | null;
  tokenVersion?: number;
}

export interface RevokeSessionResult {
  found: boolean;
}

export interface PluginSessionRepository {
  create(params: CreateSessionParams): Promise<void>;
  get(tokenHash: string): Promise<PluginSessionDoc | null>;
  revoke(tokenHash: string, now: Date): Promise<RevokeSessionResult>;
}

const COLLECTION = 'pluginSessions';

export class FirestorePluginSessionRepository implements PluginSessionRepository {
  constructor(private readonly firestore: Firestore) {}

  async create(params: CreateSessionParams): Promise<void> {
    const doc: PluginSessionDoc = {
      tokenHash: params.tokenHash,
      installId: params.installId,
      scope: params.scope,
      createdAt: params.now,
      expiresAt: params.expiresAt,
      revokedAt: null,
      ...(params.tokenType !== undefined ? { tokenType: params.tokenType } : {}),
      ...(params.userId !== undefined ? { userId: params.userId } : {}),
      ...(params.tokenVersion !== undefined ? { tokenVersion: params.tokenVersion } : {}),
    };
    await this.firestore.collection(COLLECTION).doc(params.tokenHash).set(doc);
  }

  async get(tokenHash: string): Promise<PluginSessionDoc | null> {
    const snapshot = await this.firestore.collection(COLLECTION).doc(tokenHash).get();
    return snapshot.exists ? normalizeDoc(snapshot.data() as PluginSessionDoc) : null;
  }

  async revoke(tokenHash: string, now: Date): Promise<RevokeSessionResult> {
    const ref = this.firestore.collection(COLLECTION).doc(tokenHash);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      return { found: false };
    }
    await ref.set({ revokedAt: now }, { merge: true });
    return { found: true };
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。 */
export class InMemoryPluginSessionRepository implements PluginSessionRepository {
  private readonly store = new Map<string, PluginSessionDoc>();

  async create(params: CreateSessionParams): Promise<void> {
    this.store.set(params.tokenHash, {
      tokenHash: params.tokenHash,
      installId: params.installId,
      scope: params.scope,
      createdAt: params.now,
      expiresAt: params.expiresAt,
      revokedAt: null,
      ...(params.tokenType !== undefined ? { tokenType: params.tokenType } : {}),
      ...(params.userId !== undefined ? { userId: params.userId } : {}),
      ...(params.tokenVersion !== undefined ? { tokenVersion: params.tokenVersion } : {}),
    });
  }

  async get(tokenHash: string): Promise<PluginSessionDoc | null> {
    return this.store.get(tokenHash) ?? null;
  }

  async revoke(tokenHash: string, now: Date): Promise<RevokeSessionResult> {
    const existing = this.store.get(tokenHash);
    if (!existing) {
      return { found: false };
    }
    this.store.set(tokenHash, { ...existing, revokedAt: now });
    return { found: true };
  }
}
