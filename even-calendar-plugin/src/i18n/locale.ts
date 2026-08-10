// ロケール('ja'|'en')検出とプラグイン全体の「現在ロケール」状態の一元管理。
//
// Even Hub SDKにはlocale/language APIが存在しない(getUserInfo()は{uid,name,avatar,country}、
// getDeviceInfo()は{model,sn,status}のみで、typingsにlocale/languageの語は無い)。countryを
// 言語の代理として使うのは誤りなので採用しない。
//
// detectLocale()はnavigatorを直接参照しない純関数(vitestはenvironment:'node'のため)。
// 呼び出し側(app.ts/main.ts)がglobalThis.navigator?.languagesを読んで注入すること。
//
// setActiveLocale/getActiveLocaleはerrors.ts/screens.ts等が「シグネチャを変えずに」ロケールを
// 参照するためのモジュールスコープの現在値。既定は'ja'(既存の日本語表示・既存テストと完全互換)。

export type Locale = 'ja' | 'en'

export const SUPPORTED_LOCALES: readonly Locale[] = ['ja', 'en']

function isSupportedLocale(value: unknown): value is Locale {
  return value === 'ja' || value === 'en'
}

/** BCP47言語タグ(例:'en-US'、'ja_JP')の先頭サブタグを取り出し、対応言語ならLocaleを返す。 */
function primarySubtagLocale(tag: string): Locale | null {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0]
  if (primary === 'ja') return 'ja'
  if (primary === 'en') return 'en'
  return null
}

export interface DetectLocaleParams {
  /** 永続化済みの値があれば('ja'|'en'のみ)最優先。それ以外の値(未対応言語・不正値)は無視する。 */
  stored: string | null | undefined
  /** 通常はglobalThis.navigator?.languagesをそのまま渡す。先頭要素のprimary subtagのみを見る。 */
  navigatorLanguages: readonly string[] | null | undefined
}

/** 優先順位: stored('ja'|'en'のみ受理) > navigatorLanguagesの先頭要素のprimary subtag > 'ja'。 */
export function detectLocale(params: DetectLocaleParams): Locale {
  if (isSupportedLocale(params.stored)) return params.stored

  const primaryTag = params.navigatorLanguages?.[0]
  if (typeof primaryTag === 'string') {
    const locale = primarySubtagLocale(primaryTag)
    if (locale) return locale
  }

  return 'ja'
}

let activeLocale: Locale = 'ja'

/** アプリ起動時(app.ts/main.ts)に一度だけdetectLocale()の結果を設定する想定。 */
export function setActiveLocale(locale: Locale): void {
  activeLocale = locale
}

/** errors.ts/screens.ts等の表示関数が内部で参照する現在ロケール。既定は'ja'。 */
export function getActiveLocale(): Locale {
  return activeLocale
}

/** テスト専用。モジュールスコープの可変状態がテスト間でリークしないよう、各テストのafterEach等で呼ぶこと。 */
export function resetActiveLocaleForTest(): void {
  activeLocale = 'ja'
}
