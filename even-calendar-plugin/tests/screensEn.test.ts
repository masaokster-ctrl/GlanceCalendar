import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as screens from '../src/screens'
import { resetActiveLocaleForTest, setActiveLocale } from '../src/i18n/locale'

// 英語表示の検証。既存のtests/screens.test.ts(日本語)は無改変で緑のままであること自体が
// 「既定'ja'で従来挙動と完全同一」の担保なので、ここでは英語側のみを見る。
// 可変モジュール状態(activeLocale)のテスト間リークを防ぐため必ず前後でリセットする。
beforeEach(() => {
  setActiveLocale('en')
})

afterEach(() => {
  resetActiveLocaleForTest()
})

describe('HOME_MENU_ITEMS_BY_LOCALE (Phase 2K不変条件)', () => {
  it('holds exactly 6 items in both locales', () => {
    expect(screens.HOME_MENU_ITEMS_BY_LOCALE.ja).toHaveLength(6)
    expect(screens.HOME_MENU_ITEMS_BY_LOCALE.en).toHaveLength(6)
    expect(screens.HOME_MENU_ITEM_COUNT).toBe(6)
  })

  it('keeps index 4 as the Google Calendar reconnect entry in both locales', () => {
    expect(screens.HOME_MENU_ITEMS_BY_LOCALE.ja[4]).toBe('Googleカレンダーを再接続')
    expect(screens.HOME_MENU_ITEMS_BY_LOCALE.en[4]).toBe('Reconnect Google Calendar')
  })

  it('keeps index 5 as the Language selection entry in both locales', () => {
    expect(screens.HOME_MENU_ITEMS_BY_LOCALE.ja[5]).toBe('言語')
    expect(screens.HOME_MENU_ITEMS_BY_LOCALE.en[5]).toBe('Language')
  })

  it('keeps the first 4 actions in their original order in the English locale', () => {
    expect(screens.HOME_MENU_ITEMS_BY_LOCALE.en.slice(0, 4)).toEqual([
      'New event',
      'Next 5 events',
      "Today's events",
      "Tomorrow's events",
    ])
  })

  it('still exports the Japanese array as HOME_MENU_ITEMS for backward compatibility', () => {
    expect(screens.HOME_MENU_ITEMS).toEqual(screens.HOME_MENU_ITEMS_BY_LOCALE.ja)
  })

  it('has no item containing a full-width tilde or en dash (G2フォント欠字回避)', () => {
    for (const item of [...screens.HOME_MENU_ITEMS_BY_LOCALE.en, ...screens.EVENT_DETAIL_MENU_ITEMS]) {
      expect(item).not.toContain('〜')
      expect(item).not.toContain('–')
    }
  })
})

describe('homeScreenText (en)', () => {
  it('renders a 3-item window with an N/6 indicator and the English cursor line', () => {
    const text = screens.homeScreenText(0)
    expect(text).toContain('Calendar with Gemini 1/6')
    expect(text).toContain('> New event')
    expect(text).not.toContain('予定を登録')
  })

  it('shifts the window to keep Reconnect Google Calendar visible and selected at index 4', () => {
    const text = screens.homeScreenText(4)
    expect(text).toContain('5/6')
    expect(text).toContain('> Reconnect Google Calendar')
    expect(text).toContain('  Language')
    expect(text).not.toContain('> New event')
  })

  it('shifts the window to keep the last item (Language) visible and selected', () => {
    const text = screens.homeScreenText(5)
    expect(text).toContain('6/6')
    expect(text).toContain('> Language')
    expect(text).toContain('  Reconnect Google Calendar')
    expect(text).not.toContain('> New event')
  })

  it('shows English navigation hints', () => {
    const text = screens.homeScreenText(0)
    expect(text).toContain('Swipe: select')
    expect(text).toContain('Press: open')
    expect(text).toContain('Double press: exit')
  })
})

describe('flow screens (en)', () => {
  it('renders the recording and captured screens in English', () => {
    expect(screens.recordingScreenText()).toContain('Recording...')
    expect(screens.capturedScreenText(2.4)).toContain('Length: about 2s')
    expect(screens.capturedScreenText(0.1)).toContain('Length: about 1s')
  })

  it('renders candidate/final-confirm/registered screens in English', () => {
    expect(screens.candidateScreenText('Standup', 'Aug 3, 10:00-11:00')).toContain('Review event')
    expect(screens.finalConfirmScreenText('Standup', 'Aug 3, 10:00-11:00')).toContain('Add this event?')
    expect(screens.registeredScreenText('Aug 3, 10:00-11:00')).toContain('Event added')
  })

  it('renders list screens in English including the day labels', () => {
    expect(screens.dayLoadingScreenText('today')).toContain("Today's events")
    expect(screens.dayEmptyScreenText('tomorrow')).toContain("Tomorrow's events")
    expect(screens.dayEmptyScreenText('tomorrow')).toContain('No events')
    expect(screens.upcomingEmptyScreenText()).toContain('Next 5 events')
  })

  it('renders the detail action menu in English', () => {
    const text = screens.eventDetailMenuScreenText(1)
    expect(text).toContain('Menu')
    expect(text).toContain('> Delete')
    expect(text).toContain('  Edit')
    expect(text).not.toContain('編集')
  })

  it('renders pairing screens in English', () => {
    expect(screens.notConnectedScreenText()).toContain('Google Calendar')
    expect(screens.pairingScreenText('example.com', 'ABCD-EFGH')).toContain('Open on your phone')
    expect(screens.pairingSuccessScreenText()).toContain('Connected')
    expect(screens.pairingErrorScreenText('expired')).toContain('The connection request expired')
    expect(screens.pairingErrorScreenText('auth_failure')).toContain('Authentication failed')
  })

  it('renders the language screen with English hints but option labels stay fixed (English/日本語)', () => {
    const text = screens.languageScreenText(0)
    expect(text).toContain('Language')
    expect(text).toContain('> English')
    expect(text).toContain('  日本語')
    expect(text).toContain('Double press: diagnostics')
  })

  it('renders the diagnostics screen labels in English', () => {
    const text = screens.languageDiagnosticsScreenText({
      navigatorLanguages: '(empty)',
      navigatorLanguage: '(empty)',
      documentLang: '(empty)',
      intlLocale: 'en-US',
      stored: 'en',
      active: 'en',
      deviceInfoStatus: 'fail',
      glassesInfoStatus: 'fail',
    })
    expect(text).toContain('Diagnostics')
    expect(text).toContain('stored: en')
    expect(text).toContain('active: en')
    expect(text).toContain('Press/double press: back')
  })
})

describe('formatCandidateWhen (en)', () => {
  it('uses the English month-abbreviation form, not the Japanese M/D form', () => {
    const text = screens.formatCandidateWhen({ month: 8, day: 3, hour: 10, minute: 0 }, { hour: 11, minute: 30 })
    expect(text).toBe('Aug 3, 10:00-11:30')
  })

  it('reverts to the Japanese form once the locale is reset', () => {
    resetActiveLocaleForTest()
    const text = screens.formatCandidateWhen({ month: 8, day: 3, hour: 10, minute: 0 }, { hour: 11, minute: 30 })
    expect(text).toBe('8/3 10:00-11:30')
  })
})

describe('locale isolation', () => {
  it('does not leak the English locale into a subsequent Japanese render', () => {
    expect(screens.homeScreenText(0)).toContain('> New event')
    resetActiveLocaleForTest()
    expect(screens.homeScreenText(0)).toContain('> 予定を登録')
  })
})
