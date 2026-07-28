import { Firestore } from '@google-cloud/firestore';

export interface FirestoreClientConfig {
  projectId: string;
  databaseId: string;
}

/** 本番用のFirestoreクライアントを構築する。テストではこの関数を呼ばず、Fake Repositoryを使用する。 */
export function createFirestoreClient(config: FirestoreClientConfig): Firestore {
  return new Firestore({
    projectId: config.projectId,
    databaseId: config.databaseId,
  });
}
