import { CALENDAR_SCOPE } from '../auth/googleOAuthClient.js';

/**
 * 製品用OAuthのscope。既存dev用CALENDAR_SCOPEをそのまま流用するのは「現在のscopeを無条件コピー」に
 * 見えるが、これは既にAsia/Tokyo Calendar読み取り・作成の両方に必要十分な最小scopeとして
 * Phase 2F/2Gで実際に検証済みの値であり、単一の定義元(googleOAuthClient.ts)を再利用することで
 * 値のドリフトを防ぐための意図的な選択である(新しく別の文字列として複製しない)。
 * identity用にはopenidのみを追加する(email/profileは要求しない = 最小scope)。
 */
export const PRODUCT_OAUTH_SCOPES = ['openid', CALENDAR_SCOPE] as const;
