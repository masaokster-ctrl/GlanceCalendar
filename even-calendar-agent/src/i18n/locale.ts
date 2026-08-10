/**
 * locale (ja/en) の正規化ユーティリティ。
 *
 * - キー不在 -> ABSENT_LOCALE_DEFAULT ('ja')。旧クライアントは locale を一切送らないため、
 *   これにより既存挙動と完全に一致する(本番は現在 JA 専用)。
 * - キーは存在するが値が解決不能(型違い/空文字/35字超/非対応言語タグ) -> UNRESOLVED_LOCALE_FALLBACK ('en')。
 *   locale フィールドを送ってくる時点でそのクライアントは locale 対応済みであり、そこから来たゴミが
 *   黙って日本語になるべきではない。
 *
 * 正規表現なし・JSON.parse なし・throw 経路なし。malformed な入力が 500 を引き起こすことはない。
 */

export type SupportedLocale = 'ja' | 'en';

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['ja', 'en'];

export const ABSENT_LOCALE_DEFAULT: SupportedLocale = 'ja';
export const UNRESOLVED_LOCALE_FALLBACK: SupportedLocale = 'en';
export const MAX_LOCALE_LENGTH = 35;

/**
 * raw の値が存在する前提(キーの有無はこの関数の責務外)。解決できなければ
 * UNRESOLVED_LOCALE_FALLBACK ('en') を返す。例外を投げる操作は一切含まない。
 */
export function normalizeLocale(raw: unknown): SupportedLocale {
  if (typeof raw !== 'string') return UNRESOLVED_LOCALE_FALLBACK;

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOCALE_LENGTH) return UNRESOLVED_LOCALE_FALLBACK;

  const primarySubtag = trimmed.toLowerCase().split('_').join('-').split('-')[0];

  if (primarySubtag === 'ja') return 'ja';
  if (primarySubtag === 'en') return 'en';
  return UNRESOLVED_LOCALE_FALLBACK;
}

function isPlainContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Buffer.isBuffer(value);
}

/** req.query をそのまま渡すこと(req.query.locale ではない)。キー不在 -> 'ja'。 */
export function localeFromQuery(query: unknown): SupportedLocale {
  if (!isPlainContainer(query)) return ABSENT_LOCALE_DEFAULT;
  if (!('locale' in query)) return ABSENT_LOCALE_DEFAULT;
  return normalizeLocale(query.locale);
}

/** req.body をそのまま渡すこと(req.body.locale ではない)。キー不在 -> 'ja'。生の Buffer body も安全に 'ja'。 */
export function localeFromBody(body: unknown): SupportedLocale {
  if (!isPlainContainer(body)) return ABSENT_LOCALE_DEFAULT;
  if (!('locale' in body)) return ABSENT_LOCALE_DEFAULT;
  return normalizeLocale(body.locale);
}
