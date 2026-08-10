// SDKの audioControl は成功/失敗のboolean(またはthrow)しか返さないため、
// 「権限拒否」と「G2未接続」は現状 audio_start_failed として同一に扱う(区別不可)。
//
// 停止(audioControl(false))については、公式SDKの型定義はPromise<boolean>を返すとしているが、
// 公式asrテンプレートの実装はこの戻り値をawaitも判定もしていない(呼び出しが例外を投げないことのみを
// 成功の基準にしている)。実機では戻り値が厳密なtrueでないことがあるため、本アプリでも
// 「例外が投げられたか」だけをマイク停止自体の失敗基準とし、それ以外の後処理(PCM結合・秒数計算・
// 画面更新)の失敗とは別のエラーコード(audio_processing_failed)で扱う。
import { getActiveLocale, type Locale } from './i18n/locale'

export type ErrorCode =
  | 'audio_start_failed'
  | 'audio_stop_failed'
  | 'audio_processing_failed'
  | 'audio_event_timeout'
  | 'startup_page_failed'
  | 'analysis_auth_failed'
  | 'analysis_timeout'
  | 'analysis_network_error'
  | 'analysis_rate_limited'
  | 'analysis_failed'
  | 'registration_auth_failed'
  | 'registration_candidate_expired'
  | 'registration_oauth_not_connected'
  | 'registration_network_error'
  | 'registration_failed'
  | 'followup_conversation_expired'
  | 'day_events_auth_failed'
  | 'day_events_forbidden'
  | 'day_events_rate_limited'
  | 'day_events_timeout'
  | 'day_events_network_error'
  | 'day_events_failed'
  | 'event_detail_auth_failed'
  | 'event_detail_forbidden'
  | 'event_detail_rate_limited'
  | 'event_detail_timeout'
  | 'event_detail_network_error'
  | 'event_detail_failed'
  | 'event_mutation_invalid'
  | 'event_mutation_rate_limited'
  | 'event_mutation_not_connected'
  | 'event_mutation_timeout'
  | 'event_mutation_network_error'
  | 'event_mutation_failed'
  | 'edit_analysis_timeout'
  | 'edit_analysis_network_error'
  | 'edit_analysis_rate_limited'
  | 'edit_analysis_failed'
  | 'edit_analysis_not_understood'
  | 'edit_analysis_invalid_timing'
  | 'unknown'

const MESSAGES_JA: Record<ErrorCode, string> = {
  audio_start_failed: '録音を開始できませんでした',
  audio_stop_failed: 'マイクを停止できませんでした',
  audio_processing_failed: '音声の処理に失敗しました',
  audio_event_timeout: '音声データを受信できませんでした',
  startup_page_failed: '画面の初期化に失敗しました',
  // 音声解析(/plugin/analyze-audio)専用のエラー。技術的なステータスコードやエラー詳細はG2へ出さない。
  analysis_auth_failed: 'セットアップが必要です',
  analysis_timeout: '解析が時間切れになりました',
  analysis_network_error: 'サーバーに接続できません',
  analysis_rate_limited: '少し待ってください',
  analysis_failed: '音声を解析できませんでした',
  // Calendar登録(/plugin/calendar-events)専用のエラー。技術的なステータスコードやエラー詳細はG2へ出さない。
  registration_auth_failed: 'セットアップが必要です',
  registration_candidate_expired: '期限切れです',
  registration_oauth_not_connected: 'カレンダー接続が必要です',
  registration_network_error: 'サーバーに接続できません',
  registration_failed: '登録できませんでした',
  // 追加入力会話(/plugin/analyze-followup-audio)専用。auth/timeout/networkは既存analysis_*を再利用する。
  followup_conversation_expired: '最初からやり直してください',
  // 今日/明日の予定取得(/plugin/calendar-events/day)専用。ステータスコードやエラー詳細はG2へ出さない。
  day_events_auth_failed: 'セットアップが必要です',
  day_events_forbidden: 'カレンダーを読み取れません\n権限を確認してください',
  day_events_rate_limited: 'アクセスが集中しています\n少し待って再度お試しください',
  day_events_timeout: '通信できませんでした\nもう一度お試しください',
  day_events_network_error: '通信できませんでした\nもう一度お試しください',
  day_events_failed: '予定を取得できませんでした',
  // 予定詳細取得(/plugin/calendar-events/:eventId GET)専用。ステータスコードやエラー詳細はG2へ出さない。
  event_detail_auth_failed: 'セットアップが必要です',
  event_detail_forbidden: 'カレンダーを読み取れません\n権限を確認してください',
  event_detail_rate_limited: '少し待ってください',
  event_detail_timeout: '通信できませんでした\nもう一度お試しください',
  event_detail_network_error: '通信できませんでした\nもう一度お試しください',
  event_detail_failed: '予定を取得できませんでした',
  // 予定の更新/削除(PATCH・DELETE /plugin/calendar-events/:eventId)共通。not_found/conflictは
  // 専用のeventGoneScreenTextで扱うためここには含まない。
  event_mutation_invalid: '入力内容を確認してください',
  event_mutation_rate_limited: '少し待ってください',
  event_mutation_not_connected: 'カレンダー接続が必要です',
  event_mutation_timeout: '通信できませんでした\nもう一度お試しください',
  event_mutation_network_error: '通信できませんでした\nもう一度お試しください',
  event_mutation_failed: '処理できませんでした',
  // 音声編集指示の解析(/plugin/analyze-edit-audio、未実装の可能性あり)専用。auth_failedは既存のanalysis_auth_failedを再利用する。
  edit_analysis_timeout: '解析が時間切れになりました',
  edit_analysis_network_error: 'サーバーに接続できません',
  edit_analysis_rate_limited: '少し待ってください',
  edit_analysis_failed: '変更内容を解析できませんでした',
  edit_analysis_not_understood: '変更内容を認識できませんでした',
  edit_analysis_invalid_timing: '指定した日時が正しくありません',
  unknown: 'エラーが発生しました',
}

// 英語版。G2は576x288の1コンテナ表示のため、日本語版と同じ長さ感(1行は短く、改行位置も同じ)を保つ。
// 技術的なステータスコードやエラー詳細をG2へ出さない方針は日本語版と同一。
const MESSAGES_EN: Record<ErrorCode, string> = {
  audio_start_failed: 'Could not start recording',
  audio_stop_failed: 'Could not stop the mic',
  audio_processing_failed: 'Could not process the audio',
  audio_event_timeout: 'No audio data received',
  startup_page_failed: 'Could not initialize the screen',
  analysis_auth_failed: 'Setup required',
  analysis_timeout: 'Analysis timed out',
  analysis_network_error: 'Cannot reach the server',
  analysis_rate_limited: 'Please wait a moment',
  analysis_failed: 'Could not analyze the audio',
  registration_auth_failed: 'Setup required',
  registration_candidate_expired: 'Expired',
  registration_oauth_not_connected: 'Calendar connection required',
  registration_network_error: 'Cannot reach the server',
  registration_failed: 'Could not register',
  followup_conversation_expired: 'Please start over',
  day_events_auth_failed: 'Setup required',
  day_events_forbidden: 'Cannot read the calendar\nCheck permissions',
  day_events_rate_limited: 'Too many requests\nPlease try again shortly',
  day_events_timeout: 'Connection failed\nPlease try again',
  day_events_network_error: 'Connection failed\nPlease try again',
  day_events_failed: 'Could not load events',
  event_detail_auth_failed: 'Setup required',
  event_detail_forbidden: 'Cannot read the calendar\nCheck permissions',
  event_detail_rate_limited: 'Please wait a moment',
  event_detail_timeout: 'Connection failed\nPlease try again',
  event_detail_network_error: 'Connection failed\nPlease try again',
  event_detail_failed: 'Could not load the event',
  event_mutation_invalid: 'Please check your input',
  event_mutation_rate_limited: 'Please wait a moment',
  event_mutation_not_connected: 'Calendar connection required',
  event_mutation_timeout: 'Connection failed\nPlease try again',
  event_mutation_network_error: 'Connection failed\nPlease try again',
  event_mutation_failed: 'Could not complete the action',
  edit_analysis_timeout: 'Analysis timed out',
  edit_analysis_network_error: 'Cannot reach the server',
  edit_analysis_rate_limited: 'Please wait a moment',
  edit_analysis_failed: 'Could not analyze the change',
  edit_analysis_not_understood: 'Could not understand the change',
  edit_analysis_invalid_timing: 'That date or time is not valid',
  unknown: 'Something went wrong',
}

const MESSAGES: Record<Locale, Record<ErrorCode, string>> = {
  ja: MESSAGES_JA,
  en: MESSAGES_EN,
}

/**
 * シグネチャは意図的に変更しない(app.ts側の全呼び出しを書き換えないため)。
 * 現在ロケールはi18n/locale.tsのモジュールスコープ値を参照する(既定'ja' = 従来と完全同一)。
 */
export function errorMessage(code: ErrorCode): string {
  const table = MESSAGES[getActiveLocale()] ?? MESSAGES_JA
  return table[code] ?? table.unknown
}
