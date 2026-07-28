export type SanitizedErrorCode =
  | 'unknown_error'
  | 'network_error'
  | 'timeout'
  | 'rate_limited'
  | 'server_error'
  | 'auth_invalid_grant'
  | 'auth_forbidden'
  | 'not_found'
  | 'duplicate_id'
  | 'invalid_request';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractHttpStatus(err: unknown): number | undefined {
  if (!isRecord(err)) {
    return undefined;
  }
  if (typeof err.code === 'number') {
    return err.code;
  }
  if (typeof err.status === 'number') {
    return err.status;
  }
  const response = err.response;
  if (isRecord(response) && typeof response.status === 'number') {
    return response.status;
  }
  return undefined;
}

function extractSystemErrorCode(err: unknown): string | undefined {
  if (!isRecord(err)) {
    return undefined;
  }
  return typeof err.code === 'string' ? err.code : undefined;
}

/**
 * 任意のエラー(Google APIエラーを含む)を、ログへ残しても安全な分類コードへ変換する。
 * 元のエラーメッセージ・スタックトレース・APIレスポンス本文は一切保持しない。
 */
export function sanitizeError(err: unknown): SanitizedErrorCode {
  const status = extractHttpStatus(err);

  if (status === 409) return 'duplicate_id';
  if (status === 401) return 'auth_invalid_grant';
  if (status === 403) return 'auth_forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status !== undefined && status >= 500) return 'server_error';
  if (status !== undefined && status >= 400) return 'invalid_request';

  const systemCode = extractSystemErrorCode(err);
  if (systemCode === 'ETIMEDOUT' || systemCode === 'ESOCKETTIMEDOUT') return 'timeout';
  if (systemCode === 'ECONNRESET' || systemCode === 'ECONNREFUSED' || systemCode === 'ENOTFOUND') {
    return 'network_error';
  }

  return 'unknown_error';
}

/** サニタイズ済みのエラーコードのみをログへ出力する。生のエラーオブジェクトは渡さない。 */
export function logSanitizedError(event: string, err: unknown, extra?: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      level: 'error',
      event,
      sanitizedErrorCode: sanitizeError(err),
      ...extra,
    }),
  );
}
