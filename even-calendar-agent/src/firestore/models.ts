export type ActionType = 'create_event' | 'update_event' | 'delete_event';

export interface PendingEvent {
  summary: string;
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
  description: string;
}

export type ConversationState = 'awaiting_confirmation';

export interface ConversationStateDoc {
  userId: string;
  state: ConversationState;
  actionType: ActionType;
  operationId: string;
  calendarId: string;
  event: PendingEvent;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  version: number;
}

export type IdempotencyStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface IdempotencyDoc {
  operationId: string;
  actionType: ActionType;
  status: IdempotencyStatus;
  calendarId: string;
  googleEventId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  resultCode: string | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  expiresAt: Date;
}

export interface DeliveryDedupeDoc {
  deliveryKey: string;
  requestFingerprint: string;
  operationId: string | null;
  actionType: ActionType | null;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * ローカル実機開発専用の限定セッション、および(Phase 2H以降)製品用device access sessionの共有形。
 * 平文トークンは保存しない(ドキュメントIDがtokenHash)。tokenType未設定(旧ドキュメント)は'dev'として扱う。
 * tokenVersionはdeviceのみ使用し、productInstallations.tokenVersionとの一致で一括失効を検出する。
 */
export interface PluginSessionDoc {
  tokenHash: string;
  installId: string;
  scope: string[];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  tokenType?: 'dev' | 'device';
  userId?: string | null;
  tokenVersion?: number;
}

export type PluginRequestDedupeStatus = 'processing' | 'completed' | 'failed';

/** /plugin/analyze-audio のX-Request-Id重複防止。音声・解析結果は一切含まない。 */
export interface PluginRequestDedupeDoc {
  requestKeyHash: string;
  status: PluginRequestDedupeStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

/** /plugin/analyze-audio のセッション単位レート制限(60秒固定ウィンドウ)。 */
export interface PluginRateLimitDoc {
  bucketKey: string;
  count: number;
  windowStart: Date;
  expiresAt: Date;
}

export type PluginEventCandidateStatus = 'pending' | 'creating' | 'completed' | 'failed';

/**
 * event_candidateドキュメントのtiming部分(allDayと日付/日時フィールドの組)を判別可能ユニオンで表す。
 * allDay===falseの時はstartLocal/endLocalが非nullでstartDate/endDateExclusiveは両方null、
 * allDay===trueの時はその逆(startDate/endDateExclusiveが非nullでYYYY-MM-DD、startLocal/endLocalは
 * 両方null)。endDateExclusiveはGoogle Calendar API方式の排他的終了日(包含最終日+1)を保持する —
 * 内部の他レイヤー(Geminiのfragment等)が使う「包含的終了日」とは意味が異なるので、この値をそのまま
 * Google API以外の用途で「最終日」として表示に使わないこと。Firestoreへの実際の保存形は変更せず、
 * 常に4フィールドともドキュメントに存在し(非該当側はnull埋め)、この型はそれを読み書きする側の
 * コンパイル時保証として使う。
 */
export type PluginEventCandidateTiming =
  | { allDay: false; startLocal: string; endLocal: string; startDate: null; endDateExclusive: null }
  | { allDay: true; startLocal: null; endLocal: null; startDate: string; endDateExclusive: string };

/**
 * event_candidateの10分TTL候補。/plugin/calendar-eventsでの登録時、クライアント値ではなく
 * この候補の値を実際のCalendar登録に使う。音声・WAV・文字起こしは一切含まない。
 */
export interface PluginEventCandidateBase {
  candidateId: string;
  sessionHash: string;
  installIdHash: string;
  title: string;
  timeZone: string;
  status: PluginEventCandidateStatus;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  analysisRequestIdHash: string;
  operationId: string | null;
  googleEventId: string | null;
  sanitizedErrorCode: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

export type PluginEventCandidateDoc = PluginEventCandidateBase & PluginEventCandidateTiming;

/** 'expired'はstatusとして保存せず、expiresAtとの比較で読み取り時に判定する(PluginEventCandidateStatusと同じ設計方針)。 */
export type PluginConversationStatus = 'awaiting_clarification' | 'analyzing_followup' | 'completed' | 'cancelled';

export type MissingField = 'title' | 'date' | 'start_time' | 'duration' | 'multiple';

/**
 * 日付・時刻・所要時間を独立して保持する(いずれか1つだけ判明した状態も表現できる)。
 * startLocal/endLocalは dateLocal+startTimeLocal(+durationMinutes)からサーバー側で
 * 組み立てた完成形のキャッシュ(候補完成形のみ非null)。
 * endDateLocalは複数日全日候補の絶対終了日(包含的、dateLocal以上)。allDaySignalはGemini出力の
 * 終日/時刻明言の手がかり('all_day'=終日語のみ、'timed'=時刻明言、null=どちらの手がかりも無し)。
 * allDayは候補完成時に確定した最終値(mergedFragments段階では常にfalseのままでよい)。
 */
export interface PartialCandidate {
  title: string | null;
  dateLocal: string | null;
  startTimeLocal: string | null;
  durationMinutes: number | null;
  startLocal: string | null;
  endLocal: string | null;
  timeZone: string;
  allDay: boolean;
  endDateLocal: string | null;
  allDaySignal: 'all_day' | 'timed' | null;
}

/**
 * 不足項目の追加質問による会話状態。TTL 10分。音声・WAV・文字起こし・Gemini生レスポンス・
 * clarificationQuestion全文は一切保存しない(missingField/clarificationQuestionCodeという
 * 構造化された安全な識別子のみを保持する)。
 */
export interface PluginConversationStateDoc {
  conversationId: string;
  sessionHash: string;
  installIdHash: string;
  turnCount: number;
  status: PluginConversationStatus;
  partialCandidate: PartialCandidate;
  missingField: MissingField | null;
  clarificationQuestionCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  lastRequestIdHash: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 2H: 製品用認証・ペアリング基盤。Google email/userCode/OAuth code/token/
// Calendar内容は一切保存しない(ハッシュ・enum・タイムスタンプのみ)。
// ─────────────────────────────────────────────────────────────────────────

export type ProductUserStatus = 'active' | 'disabled' | 'deletion_pending';

/** 製品ユーザー。Google emailは保存する場合もハッシュのみ(オプション)。生値は一切保持しない。 */
export interface ProductUserDoc {
  userId: string;
  googleSubjectHash: string;
  googleEmailHash: string | null;
  status: ProductUserStatus;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  termsVersion: string | null;
  privacyVersion: string | null;
}

export type ProductCredentialSanitizedStatus = 'ok' | 'invalid_grant' | 'not_configured';

/**
 * ciphertextBase64はGoogleCredentialCipher(Cloud KMS)による暗号化済みblob(base64)。平文は
 * 一切保持しない。cipherProvider/keyName/aadVersionはciphertextを自己記述的にし、将来の鍵移行や
 * providerの切り替えを安全にする。
 */
export interface ProductGoogleCredentialDoc {
  userId: string;
  cipherProvider: string;
  keyName: string;
  ciphertextBase64: string;
  aadVersion: string;
  grantedScopes: string[];
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
  lastRefreshAt: Date | null;
  sanitizedStatus: ProductCredentialSanitizedStatus;
}

export type ProductInstallationStatus = 'active' | 'revoked';

/** userIdはペアリング完了まではnull。tokenVersionを上げることでdevice sessionを一括失効できる。 */
export interface ProductInstallationDoc {
  installationId: string;
  userId: string | null;
  status: ProductInstallationStatus;
  createdAt: Date;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  tokenVersion: number;
  appVersion: string | null;
  sdkVersion: string | null;
}

export type ProductPairingStatus =
  | 'pending'
  | 'oauth_in_progress'
  | 'approved'
  | 'exchanged'
  | 'expired'
  | 'cancelled'
  | 'failed';

/**
 * userCode/installationIdは生値を保存せずハッシュのみ。TTL10分。1installationにつきactiveは1件
 * (新規開始時に旧pendingをcancelledにする)。
 */
export interface ProductPairingSessionDoc {
  pairingId: string;
  userCodeHash: string;
  installationIdHash: string;
  status: ProductPairingStatus;
  createdAt: Date;
  expiresAt: Date;
  approvedAt: Date | null;
  exchangedAt: Date | null;
  userId: string | null;
  attemptCount: number;
  lastPollAt: Date | null;
  sanitizedErrorCode: string | null;
  /**
   * client-generated credential方式(Plugin側がaccess/refresh token候補を生成しhashのみ送信する)の
   * 冪等キー。一度セットされたら別の値へは書き換えない。同じhashペアの再送は冪等replayとして成功、
   * 異なるhashペアはhash_mismatchとして拒否する(exchangedAtはreplayのたびに更新してよいが、
   * これらのhash自体・pluginSessions/productDeviceRefreshTokensの中身は初回確定時のまま不変)。
   */
  exchangeAccessTokenHash: string | null;
  exchangeRefreshTokenHash: string | null;
}

/**
 * Rotating refresh token family。生値は保存せずhashのみ。reuse検出時はfamily全体を失効させる。
 */
export interface ProductDeviceRefreshTokenDoc {
  refreshTokenHash: string;
  installationId: string;
  userId: string;
  familyId: string;
  generation: number;
  createdAt: Date;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  replacedByHash: string | null;
  reuseDetectedAt: Date | null;
}

/** 監査ログ。生のuserId/installationId/requestIdは保存せずハッシュのみ。 */
export interface ProductAuditEventDoc {
  auditId: string;
  userIdHash: string | null;
  installationIdHash: string | null;
  requestIdHash: string | null;
  action: string;
  result: string;
  sanitizedErrorCode: string | null;
  createdAt: Date;
}
