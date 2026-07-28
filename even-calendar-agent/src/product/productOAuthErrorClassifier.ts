/**
 * Google OAuth token endpoint(および関連呼び出し)の失敗を、ログ・pairing.sanitizedErrorCodeへ
 * 安全に残せるenumへ分類する。error_description・レスポンス本文全体などの自由文字列/生データは
 * 一切保持しない。参照するのはHTTPステータスと、Googleが返す標準化された'error'フィールド
 * (RFC 6749 5.2で定義されたenum値)のみ。
 *
 * 重要な既知の制約: Googleの token endpoint は、期限切れ・再利用済み・PKCE不一致・
 * redirect_uri不一致のいずれも単一の 'invalid_grant' としてまとめて返す(token交換時点では
 * redirect_uri_mismatchという個別のerror値は返らない — それはauthorize時点でのみブラウザ上に
 * 表示されるページレベルのエラー)。そのため 'redirect_uri_mismatch' はこの分類器では区別できず、
 * 'invalid_grant' に含まれる。redirect_uri不一致が疑われる場合は設定を手動で確認する必要がある。
 */
export type ProductOAuthTokenErrorCode =
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'invalid_request'
  | 'provider_unavailable'
  | 'token_response_invalid'
  | 'unknown';

const KNOWN_GOOGLE_OAUTH_ERRORS = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function classifyProductOAuthTokenError(err: unknown): ProductOAuthTokenErrorCode {
  if (!isRecord(err)) return 'unknown';

  const response = isRecord(err.response) ? err.response : undefined;
  const status = typeof response?.status === 'number' ? response.status : undefined;
  const data = isRecord(response?.data) ? response.data : undefined;
  const googleError = typeof data?.error === 'string' ? data.error : undefined;

  if (googleError && KNOWN_GOOGLE_OAUTH_ERRORS.has(googleError)) {
    if (googleError === 'invalid_client') return 'invalid_client';
    if (googleError === 'invalid_grant') return 'invalid_grant';
    if (googleError === 'unauthorized_client') return 'unauthorized_client';
    return 'invalid_request';
  }

  // Googleの'error'本文が読み取れない場合は、HTTPステータスから推定する。
  // 401はclient認証失敗(invalid_client)、400はinvalid_grant系であることが大半。
  if (status === 401) return 'invalid_client';
  if (status === 400) return 'invalid_grant';
  if (status !== undefined && status >= 500) return 'provider_unavailable';

  const systemCode = typeof err.code === 'string' ? err.code : undefined;
  if (systemCode === 'ETIMEDOUT' || systemCode === 'ESOCKETTIMEDOUT' || systemCode === 'ECONNRESET' || systemCode === 'ECONNREFUSED' || systemCode === 'ENOTFOUND') {
    return 'provider_unavailable';
  }

  // HTTPレスポンス形状を持たない例外(JSON parse失敗・ライブラリ内部処理エラー等)は、
  // 通信自体は成立したがレスポンスの取り扱いに失敗したケースとして扱う。
  if (err instanceof Error && !response) {
    return 'token_response_invalid';
  }

  return 'unknown';
}
