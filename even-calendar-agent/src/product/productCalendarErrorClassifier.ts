/**
 * Product mode(userIdを伴うcredentialのrefresh、およびGoogle Calendar API呼び出し)の失敗を、
 * ログ・Firestoreへ安全に残せるenumへ分類する。dev modeの既存sanitizeError()とは独立しており、
 * dev側のsanitizedErrorCode値・挙動には一切影響しない。error_description・レスポンス本文・
 * Calendar内容などの自由文字列/生データは一切保持しない。
 *
 * Google token endpoint(refresh_token grant)のエラーは{error: "invalid_grant"}のような
 * 標準化された文字列enumを持つのに対し、Calendar API v3のエラーは{error: {code, message, errors}}
 * という異なる形(errorがオブジェクト)を持つ。この形の違いを使い、同じ例外オブジェクトの形からでも
 * 「refresh失敗」と「Calendar API呼び出し自体の失敗」を区別する。
 *
 * 既知の制約: token endpointがエラー文字列を含まない単純なHTTP 401を返すケースは、
 * (productOAuthErrorClassifierと同様に)client認証失敗、すなわちrefresh側の問題として扱う。
 * Calendar API v3が本文なしで401を返すことは実運用上ほぼ無い。403は逆にrefresh token endpointが
 * 使わないステータスのため、常にCalendar API側(権限不足)として扱う。
 */
export type ProductCalendarErrorCode =
  | 'product_google_refresh_invalid_client'
  | 'product_google_refresh_invalid_grant'
  | 'product_google_refresh_unauthorized_client'
  | 'product_calendar_unauthorized'
  | 'product_calendar_forbidden'
  | 'product_calendar_quota'
  | 'product_calendar_provider_unavailable'
  | 'product_calendar_invalid_response'
  | 'product_calendar_conflict'
  | 'product_calendar_unknown';

const KNOWN_GOOGLE_OAUTH_ERRORS = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function classifyProductCalendarError(err: unknown): ProductCalendarErrorCode {
  if (!isRecord(err)) return 'product_calendar_unknown';

  const response = isRecord(err.response) ? err.response : undefined;
  const status = typeof response?.status === 'number' ? response.status : undefined;
  const data = isRecord(response?.data) ? response.data : undefined;
  const tokenEndpointError = typeof data?.error === 'string' ? data.error : undefined;

  if (tokenEndpointError && KNOWN_GOOGLE_OAUTH_ERRORS.has(tokenEndpointError)) {
    if (tokenEndpointError === 'invalid_client') return 'product_google_refresh_invalid_client';
    if (tokenEndpointError === 'unauthorized_client') return 'product_google_refresh_unauthorized_client';
    return 'product_google_refresh_invalid_grant';
  }

  if (status === 401) return 'product_google_refresh_invalid_client';
  if (status === 403) return 'product_calendar_forbidden';
  if (status === 412) return 'product_calendar_conflict';
  if (status === 429) return 'product_calendar_quota';
  if (status !== undefined && status >= 500) return 'product_calendar_provider_unavailable';
  if (status !== undefined && status >= 400) return 'product_calendar_invalid_response';

  const systemCode = typeof err.code === 'string' ? err.code : undefined;
  if (systemCode === 'ETIMEDOUT' || systemCode === 'ESOCKETTIMEDOUT' || systemCode === 'ECONNRESET' || systemCode === 'ECONNREFUSED' || systemCode === 'ENOTFOUND') {
    return 'product_calendar_provider_unavailable';
  }

  return 'product_calendar_unknown';
}
