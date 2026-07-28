export interface OAuthVerificationStatus {
  lastVerifiedAt: Date | null;
  lastVerificationSucceeded: boolean | null;
}

export interface OAuthVerificationTracker {
  recordSuccess(now: Date): void;
  recordFailure(now: Date): void;
  getStatus(): OAuthVerificationStatus;
}

/**
 * OAuth連携の最終確認結果をインスタンス内メモリのみで保持する。
 * OAuth関連情報はFirestoreへ保存しないため、この状態はインスタンス再起動で失われる
 * (単一インスタンス運用のPhase 1Aでは許容する設計上の制約)。
 */
export function createInMemoryOAuthVerificationTracker(): OAuthVerificationTracker {
  let status: OAuthVerificationStatus = { lastVerifiedAt: null, lastVerificationSucceeded: null };

  return {
    recordSuccess(now: Date): void {
      status = { lastVerifiedAt: now, lastVerificationSucceeded: true };
    },
    recordFailure(now: Date): void {
      status = { lastVerifiedAt: now, lastVerificationSucceeded: false };
    },
    getStatus(): OAuthVerificationStatus {
      return status;
    },
  };
}
