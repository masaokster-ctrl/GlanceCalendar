import type { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import type { ProductAuditEventDoc } from '../firestore/models.js';

export interface RecordAuditParams {
  userIdHash: string | null;
  installationIdHash: string | null;
  requestIdHash: string | null;
  action: string;
  result: string;
  sanitizedErrorCode: string | null;
  now: Date;
}

export interface ProductAuditRepository {
  record(params: RecordAuditParams): Promise<void>;
}

const COLLECTION = 'productAuditEvents';

export class FirestoreProductAuditRepository implements ProductAuditRepository {
  constructor(private readonly firestore: Firestore) {}

  async record(params: RecordAuditParams): Promise<void> {
    const doc: ProductAuditEventDoc = {
      auditId: randomUUID(),
      userIdHash: params.userIdHash,
      installationIdHash: params.installationIdHash,
      requestIdHash: params.requestIdHash,
      action: params.action,
      result: params.result,
      sanitizedErrorCode: params.sanitizedErrorCode,
      createdAt: params.now,
    };
    await this.firestore.collection(COLLECTION).doc(doc.auditId).set(doc);
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。 */
export class InMemoryProductAuditRepository implements ProductAuditRepository {
  public readonly entries: ProductAuditEventDoc[] = [];

  async record(params: RecordAuditParams): Promise<void> {
    this.entries.push({
      auditId: randomUUID(),
      userIdHash: params.userIdHash,
      installationIdHash: params.installationIdHash,
      requestIdHash: params.requestIdHash,
      action: params.action,
      result: params.result,
      sanitizedErrorCode: params.sanitizedErrorCode,
      createdAt: params.now,
    });
  }
}
