import type { Firestore } from '@google-cloud/firestore';
import type { ConversationStateDoc } from './models.js';

export interface ConversationStateRepository {
  get(userId: string): Promise<ConversationStateDoc | null>;
  /** 新規の確認待ち状態を保存する。既存の確認待ち状態があれば置き換える。 */
  save(doc: ConversationStateDoc): Promise<void>;
  clear(userId: string): Promise<void>;
}

const COLLECTION = 'conversationStates';

export class FirestoreConversationStateRepository implements ConversationStateRepository {
  constructor(private readonly firestore: Firestore) {}

  async get(userId: string): Promise<ConversationStateDoc | null> {
    const snapshot = await this.firestore.collection(COLLECTION).doc(userId).get();
    if (!snapshot.exists) {
      return null;
    }
    return snapshot.data() as ConversationStateDoc;
  }

  async save(doc: ConversationStateDoc): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(doc.userId).set(doc);
  }

  async clear(userId: string): Promise<void> {
    await this.firestore.collection(COLLECTION).doc(userId).delete();
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。 */
export class InMemoryConversationStateRepository implements ConversationStateRepository {
  private readonly store = new Map<string, ConversationStateDoc>();

  async get(userId: string): Promise<ConversationStateDoc | null> {
    return this.store.get(userId) ?? null;
  }

  async save(doc: ConversationStateDoc): Promise<void> {
    this.store.set(doc.userId, doc);
  }

  async clear(userId: string): Promise<void> {
    this.store.delete(userId);
  }
}
