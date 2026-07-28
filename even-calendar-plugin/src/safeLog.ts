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
}

export function logSafe(fields: SafeLogFields): void {
  console.log(JSON.stringify(fields))
}
