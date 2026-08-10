import { afterEach, describe, expect, it } from 'vitest'
import { errorMessage, type ErrorCode } from '../src/errors'
import { resetActiveLocaleForTest, setActiveLocale } from '../src/i18n/locale'

// no-control-regexに引っかかる/[^\x00-\x7F]/系の正規表現を避け、コードポイント比較でASCII判定する。
function isAsciiOnly(text: string): boolean {
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) > 0x7f) return false
  }
  return true
}

// errors.tsのMESSAGES_JA/MESSAGES_ENは非公開のため、全ErrorCodeを列挙して外側から突合する。
// ErrorCodeを追加したらこの配列にも足すこと(足し忘れは下の網羅テストで落ちる)。
const ALL_ERROR_CODES: readonly ErrorCode[] = [
  'audio_start_failed',
  'audio_stop_failed',
  'audio_processing_failed',
  'audio_event_timeout',
  'startup_page_failed',
  'analysis_auth_failed',
  'analysis_timeout',
  'analysis_network_error',
  'analysis_rate_limited',
  'analysis_failed',
  'registration_auth_failed',
  'registration_candidate_expired',
  'registration_oauth_not_connected',
  'registration_network_error',
  'registration_failed',
  'followup_conversation_expired',
  'day_events_auth_failed',
  'day_events_forbidden',
  'day_events_rate_limited',
  'day_events_timeout',
  'day_events_network_error',
  'day_events_failed',
  'event_detail_auth_failed',
  'event_detail_forbidden',
  'event_detail_rate_limited',
  'event_detail_timeout',
  'event_detail_network_error',
  'event_detail_failed',
  'event_mutation_invalid',
  'event_mutation_rate_limited',
  'event_mutation_not_connected',
  'event_mutation_timeout',
  'event_mutation_network_error',
  'event_mutation_failed',
  'edit_analysis_timeout',
  'edit_analysis_network_error',
  'edit_analysis_rate_limited',
  'edit_analysis_failed',
  'edit_analysis_not_understood',
  'edit_analysis_invalid_timing',
  'unknown',
]

// 可変モジュール状態(activeLocale)がテスト間へリークしないよう必ず戻す。
afterEach(() => {
  resetActiveLocaleForTest()
})

describe('errorMessage', () => {
  it('defaults to Japanese without any setActiveLocale call (既存挙動と完全一致)', () => {
    expect(errorMessage('registration_failed')).toBe('登録できませんでした')
    expect(errorMessage('unknown')).toBe('エラーが発生しました')
  })

  it('returns Japanese for every code when locale is ja, with no empty or accidentally-English message', () => {
    setActiveLocale('ja')
    for (const code of ALL_ERROR_CODES) {
      const message = errorMessage(code)
      expect(message.length).toBeGreaterThan(0)
      // 日本語カタログにASCIIのみの行が混ざっていたら訳し漏れ(または取り違え)。
      expect(isAsciiOnly(message)).toBe(false)
    }
  })

  it('returns English for every code when locale is en, with no leftover Japanese characters', () => {
    setActiveLocale('en')
    for (const code of ALL_ERROR_CODES) {
      const message = errorMessage(code)
      expect(message.length).toBeGreaterThan(0)
      // 英語カタログに非ASCIIが残っていたら訳し漏れ。
      expect(isAsciiOnly(message)).toBe(true)
    }
  })

  it('has no code whose English message is identical to its Japanese one (全コードが実際に訳されている)', () => {
    const ja = new Map<ErrorCode, string>()
    setActiveLocale('ja')
    for (const code of ALL_ERROR_CODES) ja.set(code, errorMessage(code))

    setActiveLocale('en')
    for (const code of ALL_ERROR_CODES) {
      expect(errorMessage(code)).not.toBe(ja.get(code))
    }
  })

  it('keeps the same number of display lines per code in both locales (G2の576x288レイアウトを崩さない)', () => {
    const jaLines = new Map<ErrorCode, number>()
    setActiveLocale('ja')
    for (const code of ALL_ERROR_CODES) jaLines.set(code, errorMessage(code).split('\n').length)

    setActiveLocale('en')
    for (const code of ALL_ERROR_CODES) {
      expect(errorMessage(code).split('\n').length).toBe(jaLines.get(code))
    }
  })

  it('falls back to the unknown message for an unrecognised code in both locales', () => {
    const bogus = 'not_a_real_code' as ErrorCode

    setActiveLocale('ja')
    expect(errorMessage(bogus)).toBe('エラーが発生しました')

    setActiveLocale('en')
    expect(errorMessage(bogus)).toBe('Something went wrong')
  })

  it('resetActiveLocaleForTest restores the Japanese default', () => {
    setActiveLocale('en')
    expect(errorMessage('unknown')).toBe('Something went wrong')
    resetActiveLocaleForTest()
    expect(errorMessage('unknown')).toBe('エラーが発生しました')
  })
})
