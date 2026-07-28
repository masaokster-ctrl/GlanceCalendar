import type { Firestore, Transaction } from '@google-cloud/firestore';
import { createHash } from 'node:crypto';
import type { PluginRateLimitDoc } from './models.js';

const WINDOW_MS = 60_000;
const DOC_TTL_MS = 70_000; // ウィンドウ終了後、TTL掃除までの猶予

export interface RateLimitCheckParams {
  sessionKey: string;
  now: Date;
  limit: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface PluginRateLimitRepository {
  /** Firestoreトランザクションによる60秒固定ウィンドウのカウンター。複数Cloud Runインスタンスでも機能する。 */
  consume(params: RateLimitCheckParams): Promise<RateLimitResult>;
}

const COLLECTION = 'pluginRateLimits';

function bucketKeyFor(sessionKey: string, now: Date): { key: string; windowStart: Date; retryAfterSeconds: number } {
  const windowStartMs = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  const windowStart = new Date(windowStartMs);
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + WINDOW_MS - now.getTime()) / 1000));
  const key = createHash('sha256').update(`${sessionKey}:${windowStartMs}`, 'utf8').digest('hex');
  return { key, windowStart, retryAfterSeconds };
}

export class FirestorePluginRateLimitRepository implements PluginRateLimitRepository {
  constructor(private readonly firestore: Firestore) {}

  async consume(params: RateLimitCheckParams): Promise<RateLimitResult> {
    const { key, windowStart, retryAfterSeconds } = bucketKeyFor(params.sessionKey, params.now);
    const ref = this.firestore.collection(COLLECTION).doc(key);

    const allowed = await this.firestore.runTransaction(async (tx: Transaction) => {
      const snapshot = await tx.get(ref);
      const existing = snapshot.exists ? (snapshot.data() as PluginRateLimitDoc) : null;
      const currentCount = existing?.count ?? 0;

      if (currentCount >= params.limit) {
        return false;
      }

      const doc: PluginRateLimitDoc = {
        bucketKey: key,
        count: currentCount + 1,
        windowStart,
        expiresAt: new Date(windowStart.getTime() + DOC_TTL_MS),
      };
      tx.set(ref, doc);
      return true;
    });

    return { allowed, retryAfterSeconds };
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。 */
export class InMemoryPluginRateLimitRepository implements PluginRateLimitRepository {
  private readonly store = new Map<string, number>();

  async consume(params: RateLimitCheckParams): Promise<RateLimitResult> {
    const { key, retryAfterSeconds } = bucketKeyFor(params.sessionKey, params.now);
    const currentCount = this.store.get(key) ?? 0;

    if (currentCount >= params.limit) {
      return { allowed: false, retryAfterSeconds };
    }

    this.store.set(key, currentCount + 1);
    return { allowed: true, retryAfterSeconds };
  }
}
