// 許可された安全なフィールドのみを受け取る構造化ログ。PCM/base64/Blob内容・発話テキスト・
// Token/Secret/OAuth/Calendar内容はこの型に存在しないため、誤って渡すことを型レベルで防ぐ。
export interface SafeLogFields {
  event: string
  state?: string
  micPermission?: boolean
  startResult?: boolean
  stopResult?: boolean
  chunkCount?: number
  totalBytes?: number
  seconds?: number
  backendAvailable?: boolean
  errorCode?: string
  // /plugin/analyze-audio 呼び出し専用の安全なフィールド。発話内容・予定内容・token・installId生値は含まない。
  resultType?: string
  wavBytes?: number
  // /plugin/calendar-events/day 呼び出し専用の安全なフィールド。予定名・日時実値は含まない。
  resultCount?: number
  // 診断目的の一時的なロケール検出ログ専用フィールド(恒久仕様ではない)。個人情報を含まない
  // 言語タグのみ('ja'/'en'/BCP47タグの配列・文字列)。実機でnavigator.languages/navigator.languageが
  // 実際に何を返すかを次回テストで確認するためのもの。
  resolvedLocale?: string
  navigatorLanguagesRaw?: readonly string[] | null
  navigatorLanguageRaw?: string | null
  storedLocaleRaw?: string | null
}

export function logSafe(fields: SafeLogFields): void {
  console.log(JSON.stringify(fields))
}
