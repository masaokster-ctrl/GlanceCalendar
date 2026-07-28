export interface SafeLogFields {
  event: string;
  level?: 'info' | 'error';
  requestFingerprint?: string;
  actionType?: string | null;
  commandType?: string | null;
  oauthConnected?: boolean;
  firestoreOperation?: string;
  idempotencyStatus?: string;
  duplicateDetected?: boolean;
  calendarApiOperation?: string;
  calendarApiResultCode?: string;
  sanitizedErrorCode?: string;
  durationMs?: number;
  traceId?: string | null;
  httpStatus?: number;
  responseType?: string;
  instanceId?: string;
  leaseAcquired?: boolean;
  reusedCompletedResult?: boolean;
  testMode?: string;
  configuredDelayMs?: number;
  clientDisconnected?: boolean;
  elapsedMs?: number;
  // /plugin/* 専用の安全なフィールド。発話内容・予定内容・token・installId生値は含まない。
  requestIdHashPrefix?: string;
  sessionHashPrefix?: string;
  installIdHashPrefix?: string;
  receivedBytes?: number;
  estimatedDurationMs?: number;
  resultType?: string;
  geminiModel?: string;
  vertexLocation?: string;
  latencyMs?: number;
  rateLimitAllowed?: boolean;
  duplicateRequest?: boolean;
  scope?: string[];
  expiresInSeconds?: number;
  // /plugin/calendar-events* 専用の安全なフィールド。title/日時/candidate本文/googleEventId生値は含まない。
  candidateHashPrefix?: string;
  command?: string;
  status?: string;
  dedupeResult?: string;
  // /plugin/analyze-followup-audio, /plugin/conversations/cancel 専用の安全なフィールド。
  // 質問全文・回答内容・partialCandidate本文は含まない。
  conversationHashPrefix?: string;
  turnCount?: number;
  missingField?: string;
  // /plugin/calendar-events/day, /plugin/calendar-events/upcoming 専用の安全なフィールド。
  // 予定名・日時実値・Google eventIdは含まない。
  day?: 'today' | 'tomorrow';
  mode?: 'upcoming';
  resultCount?: number;
  allDayCount?: number;
  timedCount?: number;
  truncated?: boolean;
  // /plugin/calendar-events/:eventId (GET/PATCH/DELETE) 専用の安全なフィールド。
  // Google eventId・idempotencyKeyそのもの・予定内容は含まない(ハッシュprefixのみ)。
  eventIdHashPrefix?: string;
  idempotencyKeyHashPrefix?: string;
}

/**
 * 許可された安全なフィールドのみを受け取る構造化ログ出力。
 * 会話本文・予定内容・トークン・Cookie値などはこの型に存在しないため、
 * 呼び出し側が誤って渡すことを型レベルで防ぐ。
 */
export function logSafeEvent(fields: SafeLogFields): void {
  const { level = 'info', ...rest } = fields;
  const logFn = level === 'error' ? console.error : console.log;
  logFn(JSON.stringify({ level, ...rest }));
}
