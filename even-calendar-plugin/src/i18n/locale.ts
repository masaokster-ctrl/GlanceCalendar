// ロケール('ja'|'en')検出とプラグイン全体の「現在ロケール」状態の一元管理。
//
// Even Hub SDKにはlocale/language APIが存在しない(getUserInfo()は{uid,name,avatar,country}、
// getDeviceInfo()は{model,sn,status}のみで、typingsにlocale/languageの語は無い)。countryを
// 言語の代理として使うのは誤りなので採用しない。そのため、Home menuの「Language」画面で
// ユーザーが明示的に選択した値を最優先の signal として扱う(navigator検出は補助手段)。
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
  /**
   * bridge.getDeviceInfo().locale(公開API)から取得できた生の言語タグ。現行SDK実装ではDeviceInfoに
   * localeフィールドは存在しない可能性が高いため、通常はnull/undefinedになる想定だが、公式FAQが
   * この経路の参照を案内しているため、実際に値が返ってきた場合は他の何よりも優先する。
   * 未文書化の内部メソッド(callEvenApp('getGlassesInfo')等)の結果はここに含めないこと
   * (診断表示専用。SDKの将来のアップデートで予告なく壊れうる未文書化APIに製品ロジックを依存させない)。
   */
  deviceLocale?: string | null | undefined
  /**
   * ユーザーがLanguage画面で明示的に選択した言語の永続値(bridge storage)。deviceLocaleに次ぐ
   * signalとして扱う。書き込まれるのはLanguage画面での明示選択時のみ(app.tsのstart()は
   * もはや自動検出結果をここへ書き戻さない)。navigator.languages/navigator.languageがEven
   * RealitiesアプリのSystem language設定と実際に連動しているかは未確認である一方、この値は
   * ユーザー自身が明示的に選んだ結果であるため、navigatorの検出結果より優先する。
   */
  stored: string | null | undefined
  /** 通常はglobalThis.navigator?.languagesをそのまま渡す。先頭要素のprimary subtagのみを見る。 */
  navigatorLanguages: readonly string[] | null | undefined
  /**
   * 通常はglobalThis.navigator?.language(単数形)をそのまま渡す。navigatorLanguages(複数形の配列)が
   * 未実装/空配列を返す実行環境向けの追加フォールバック信号。
   */
  navigatorLanguage?: string | null | undefined
}

/**
 * 優先順位: deviceLocale(bridge.getDeviceInfo().localeの公開APIから取得・正規化できた場合のみ) >
 * stored(ユーザーがLanguage画面で明示的に選択した値。'ja'|'en'のみ受理) >
 * navigatorLanguagesの先頭要素のprimary subtag > navigatorLanguage(単数形)のprimary subtag > 'ja'。
 *
 * 注意: navigator.languages/navigator.languageがEven Realitiesアプリ自体の「表示言語」設定と
 * 実際に連動しているかどうかは未確認(SDK/ドキュメントに記載なし、plugin実行環境はFlutter WebView)。
 * これは自動検出の唯一の手段であるため、deviceLocaleもユーザーの明示選択(stored)も無い間の
 * フォールバックとして引き続き使用するが、確定した仕様として書いているわけではない。
 */
export function detectLocale(params: DetectLocaleParams): Locale {
  if (typeof params.deviceLocale === 'string') {
    const locale = primarySubtagLocale(params.deviceLocale)
    if (locale) return locale
  }

  if (isSupportedLocale(params.stored)) return params.stored

  const primaryTag = params.navigatorLanguages?.[0]
  if (typeof primaryTag === 'string') {
    const locale = primarySubtagLocale(primaryTag)
    if (locale) return locale
  }

  if (typeof params.navigatorLanguage === 'string') {
    const locale = primarySubtagLocale(params.navigatorLanguage)
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
