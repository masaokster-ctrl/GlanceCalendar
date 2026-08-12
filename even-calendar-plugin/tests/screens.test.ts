import { describe, expect, it } from 'vitest'
import * as screens from '../src/screens'

const ALL_SCREEN_TEXTS = [
  screens.homeScreenText(0),
  screens.recordingScreenText(),
  screens.capturedScreenText(12),
  screens.tooShortScreenText(),
  screens.analyzingScreenText(),
  screens.candidateScreenText('打ち合わせ', '7/23 15:00-16:00'),
  screens.finalConfirmScreenText('打ち合わせ', '7/23 15:00-16:00'),
  screens.registeringScreenText(),
  screens.checkingStatusScreenText(),
  screens.registeredScreenText('7/23 15:00-16:00'),
  screens.clarificationScreenText('何時からですか?'),
  screens.followupReadyScreenText(),
  screens.followupRecordingScreenText(),
  screens.followupCapturedScreenText(5),
  screens.notCalendarScreenText(),
  screens.dayLoadingScreenText('today'),
  screens.dayLoadingScreenText('tomorrow'),
  screens.dayEmptyScreenText('today'),
  screens.dayEventsScreenText('today', 0, 2, ['終日 休暇', '09:00-10:00 朝会', '15:00-16:00 打ち合わせ'], false, true),
  screens.dayErrorScreenText('予定を取得できませんでした'),
  screens.upcomingLoadingScreenText(),
  screens.upcomingEmptyScreenText(),
  screens.upcomingEventsScreenText(0, 2, ['7/23 14:00-15:00 打ち合わせ', '7/24 終日 休暇', '7/25 09:00-10:00 朝会'], false, true),
  screens.errorScreenText('エラーが発生しました'),
  screens.notConnectedScreenText(),
  screens.pairingScreenText('backend.test/connect', 'ABCD-EFGH'),
  screens.pairingSuccessScreenText(),
  screens.pairingErrorScreenText('expired'),
  screens.pairingErrorScreenText('communication_failure'),
  screens.pairingErrorScreenText('cancelled'),
  screens.pairingErrorScreenText('auth_failure'),
  screens.languageScreenText(0),
  screens.languageScreenText(1),
  screens.languageDiagnosticsScreenText({
    navigatorLanguages: 'en-US,fr',
    navigatorLanguage: 'en-US',
    documentLang: 'en',
    intlLocale: 'en-US',
    stored: '(empty)',
    active: 'ja',
    deviceInfoStatus: 'ok locale=(empty)',
    glassesInfoStatus: 'ok keys=model,sn,status locale=(empty)',
  }),
]

describe('screen text builders', () => {
  it('home menu holds 6 items internally: 予定を登録, 直近5件の予定, 今日の予定, 明日の予定, Googleカレンダーを再接続, 言語 (昨日の予定 removed)', () => {
    expect(screens.HOME_MENU_ITEM_COUNT).toBe(6)
    expect(screens.HOME_MENU_ITEMS).toEqual([
      '予定を登録',
      '直近5件の予定',
      '今日の予定',
      '明日の予定',
      'Googleカレンダーを再接続',
      '言語',
    ])
    expect(screens.HOME_MENU_ITEMS as readonly string[]).not.toContain('昨日の予定')
  })

  it('Phase 2K: existing first 5 items keep their original order (only the 6th item was appended)', () => {
    expect(screens.HOME_MENU_ITEMS.slice(0, 5)).toEqual([
      '予定を登録',
      '直近5件の予定',
      '今日の予定',
      '明日の予定',
      'Googleカレンダーを再接続',
    ])
    expect(screens.HOME_MENU_ITEMS[5]).toBe('言語')
  })

  it('home menu shows the app name, a N/6 position indicator, and only 3 visible items at once', () => {
    const text = screens.homeScreenText(0)
    expect(text).toContain('Calendar with Gemini 1/6')
    expect(text).toContain('> 予定を登録')
    expect(text).toContain('  直近5件の予定')
    expect(text).toContain('  今日の予定')
    expect(text).not.toContain('明日の予定') // ウィンドウ外
    expect(text).toContain('二度押し: 終了')
  })

  it('selection 0 shows items [予定を登録, 直近5件の予定, 今日の予定] with the cursor on 予定を登録', () => {
    const text = screens.homeScreenText(0)
    expect(text).toContain('Calendar with Gemini 1/6')
    expect(text).toContain('> 予定を登録')
    expect(text).toContain('  直近5件の予定')
    expect(text).toContain('  今日の予定')
    expect(text).not.toContain('明日の予定')
  })

  it('selection 1 shows the same window [予定を登録, 直近5件の予定, 今日の予定] with the cursor on 直近5件の予定', () => {
    const text = screens.homeScreenText(1)
    expect(text).toContain('Calendar with Gemini 2/6')
    expect(text).toContain('  予定を登録')
    expect(text).toContain('> 直近5件の予定')
    expect(text).toContain('  今日の予定')
    expect(text).not.toContain('明日の予定')
  })

  it('selection 2 shifts the window to [直近5件の予定, 今日の予定, 明日の予定] with the cursor on 今日の予定', () => {
    const text = screens.homeScreenText(2)
    expect(text).toContain('Calendar with Gemini 3/6')
    expect(text).not.toContain('予定を登録')
    expect(text).toContain('  直近5件の予定')
    expect(text).toContain('> 今日の予定')
    expect(text).toContain('  明日の予定')
  })

  it('selection 3 shifts the window to [今日の予定, 明日の予定, Googleカレンダーを再接続] with the cursor on 明日の予定', () => {
    const text = screens.homeScreenText(3)
    expect(text).toContain('Calendar with Gemini 4/6')
    expect(text).not.toContain('予定を登録')
    expect(text).not.toContain('直近5件の予定')
    expect(text).toContain('  今日の予定')
    expect(text).toContain('> 明日の予定')
    expect(text).toContain('  Googleカレンダーを再接続')
  })

  it('selection 4 shifts the window to [明日の予定, Googleカレンダーを再接続, 言語] with the cursor on Googleカレンダーを再接続', () => {
    const text = screens.homeScreenText(4)
    expect(text).toContain('Calendar with Gemini 5/6')
    expect(text).not.toContain('予定を登録')
    expect(text).not.toContain('直近5件の予定')
    expect(text).not.toContain('今日の予定')
    expect(text).toContain('  明日の予定')
    expect(text).toContain('> Googleカレンダーを再接続')
    expect(text).toContain('  言語')
  })

  it('selection 5 shows the same window [明日の予定, Googleカレンダーを再接続, 言語] with the cursor on 言語', () => {
    const text = screens.homeScreenText(5)
    expect(text).toContain('Calendar with Gemini 6/6')
    expect(text).not.toContain('予定を登録')
    expect(text).not.toContain('直近5件の予定')
    expect(text).not.toContain('今日の予定')
    expect(text).toContain('  明日の予定')
    expect(text).toContain('  Googleカレンダーを再接続')
    expect(text).toContain('> 言語')
  })

  it('always shows exactly 3 menu item lines regardless of selection (no native scroll needed)', () => {
    for (let i = 0; i < screens.HOME_MENU_ITEM_COUNT; i += 1) {
      const text = screens.homeScreenText(i)
      const itemLines = text.split('\n').filter((line) => line.startsWith('> ') || line.startsWith('  '))
      // ヒント行(上下スワイプ:.../押す:.../二度押し:...)も"  "始まりではないため混在しない
      const menuLines = itemLines.filter((line) => screens.HOME_MENU_ITEMS.includes(line.slice(2) as (typeof screens.HOME_MENU_ITEMS)[number]))
      expect(menuLines).toHaveLength(3)
    }
  })

  it('every home screen text stays within a small, fixed line budget (defensive against G2 text-container overflow)', () => {
    for (let i = 0; i < screens.HOME_MENU_ITEM_COUNT; i += 1) {
      const text = screens.homeScreenText(i)
      const lineCount = text.split('\n').length
      expect(lineCount).toBeLessThanOrEqual(9)
    }
  })

  it('recording screen mentions stop and cancel hints', () => {
    const text = screens.recordingScreenText()
    expect(text).toContain('録音中')
    expect(text).toContain('もう一度押して終了')
    expect(text).toContain('二度押し: キャンセル')
  })

  it('captured screen includes the rounded duration', () => {
    expect(screens.capturedScreenText(12.4)).toContain('約12秒')
    expect(screens.capturedScreenText(0.6)).toContain('約1秒')
  })

  it('day loading screen shows the day label and a loading message', () => {
    expect(screens.dayLoadingScreenText('today')).toContain('今日の予定')
    expect(screens.dayLoadingScreenText('today')).toContain('読み込み中')
    expect(screens.dayLoadingScreenText('tomorrow')).toContain('明日の予定')
  })

  it('day empty screen shows "no events" and only a double-press-to-return hint', () => {
    const text = screens.dayEmptyScreenText('today')
    expect(text).toContain('今日の予定')
    expect(text).toContain('予定はありません')
    expect(text).toContain('二度押し: 戻る')
  })

  it('day events screen shows the day label, page indicator, and event lines', () => {
    const text = screens.dayEventsScreenText(
      'today',
      0,
      2,
      ['終日 休暇', '09:00-10:00 朝会', '15:00-16:00 打ち合わせ'],
      false,
      true,
    )
    expect(text).toContain('今日の予定 1/2')
    expect(text).toContain('終日 休暇')
    expect(text).toContain('09:00-10:00 朝会')
    expect(text).toContain('15:00-16:00 打ち合わせ')
  })

  it('day events screen shows the truncated notice only on the last page when truncated', () => {
    const notLastPage = screens.dayEventsScreenText('today', 0, 2, ['a'], false, true)
    expect(notLastPage).not.toContain('ほかの予定があります')

    const lastPageNotTruncated = screens.dayEventsScreenText('today', 1, 2, ['a'], true, false)
    expect(lastPageNotTruncated).not.toContain('ほかの予定があります')

    const lastPageTruncated = screens.dayEventsScreenText('today', 1, 2, ['a'], true, true)
    expect(lastPageTruncated).toContain('ほかの予定があります')
  })

  it('day error screen shows the message and only a double-press-to-return hint', () => {
    const text = screens.dayErrorScreenText('通信できませんでした\nもう一度お試しください')
    expect(text).toContain('通信できませんでした')
    expect(text).toContain('もう一度お試しください')
    expect(text).toContain('二度押し: 戻る')
    expect(text).not.toContain('押す:')
  })

  it('upcoming loading screen shows the label and a loading message', () => {
    const text = screens.upcomingLoadingScreenText()
    expect(text).toContain('直近5件の予定')
    expect(text).toContain('読み込み中')
  })

  it('upcoming empty screen shows "no events" and only a double-press-to-return hint', () => {
    const text = screens.upcomingEmptyScreenText()
    expect(text).toContain('直近5件の予定')
    expect(text).toContain('予定はありません')
    expect(text).toContain('二度押し: 戻る')
  })

  it('upcoming events screen shows the label, page indicator, and pre-formatted event lines', () => {
    const text = screens.upcomingEventsScreenText(
      0,
      2,
      ['7/23 14:00-15:00 打ち合わせ', '7/24 終日 休暇', '7/25 09:00-10:00 朝会'],
      false,
      true,
    )
    expect(text).toContain('直近5件の予定 1/2')
    expect(text).toContain('7/23 14:00-15:00 打ち合わせ')
    expect(text).toContain('7/24 終日 休暇')
    expect(text).toContain('7/25 09:00-10:00 朝会')
  })

  it('upcoming events screen shows the truncated notice only on the last page when truncated', () => {
    const notLastPage = screens.upcomingEventsScreenText(0, 2, ['a'], false, true)
    expect(notLastPage).not.toContain('ほかの予定があります')

    const lastPageNotTruncated = screens.upcomingEventsScreenText(1, 2, ['a'], true, false)
    expect(lastPageNotTruncated).not.toContain('ほかの予定があります')

    const lastPageTruncated = screens.upcomingEventsScreenText(1, 2, ['a'], true, true)
    expect(lastPageTruncated).toContain('ほかの予定があります')
  })

  it('upcoming errors reuse dayErrorScreenText (shared error UI per spec)', () => {
    const text = screens.dayErrorScreenText('予定を取得できませんでした')
    expect(text).toContain('予定を取得できませんでした')
    expect(text).toContain('二度押し: 戻る')
  })

  it('analyzing screen mentions cancel-only hint (no single-press hint)', () => {
    const text = screens.analyzingScreenText()
    expect(text).toContain('解析中')
    expect(text).toContain('二度押し: 中止')
  })

  it('candidate screen shows the title, when-text, and registration-confirm/cancel hints', () => {
    const text = screens.candidateScreenText('打ち合わせ', '7/23 15:00-16:00')
    expect(text).toContain('予定を確認')
    expect(text).toContain('打ち合わせ')
    expect(text).toContain('7/23 15:00-16:00')
    expect(text).toContain('押す: 登録確認')
    expect(text).toContain('二度押し: 中止')
  })

  it('truncates an overly long title/question for display', () => {
    const longTitle = 'x'.repeat(200)
    const text = screens.candidateScreenText(longTitle, '7/23 15:00-16:00')
    expect(text.length).toBeLessThan(200)
    expect(text).toContain('…')
  })

  it('final confirmation screen asks for explicit registration confirmation', () => {
    const text = screens.finalConfirmScreenText('打ち合わせ', '7/23 15:00-16:00')
    expect(text).toContain('登録しますか')
    expect(text).toContain('打ち合わせ')
    expect(text).toContain('7/23 15:00-16:00')
    expect(text).toContain('押す: 登録')
    expect(text).toContain('二度押し: 中止')
  })

  it('registering screen shows an in-progress message with no action hint', () => {
    const text = screens.registeringScreenText()
    expect(text).toContain('登録中')
    expect(text).not.toContain('押す')
  })

  it('checking-status screen shows a distinct in-progress message', () => {
    const text = screens.checkingStatusScreenText()
    expect(text).toContain('確認')
    expect(text).not.toContain('押す')
  })

  it('registered screen shows success and the confirmed time, with only a home hint', () => {
    const text = screens.registeredScreenText('7/23 15:00-16:00')
    expect(text).toContain('登録しました')
    expect(text).toContain('7/23 15:00-16:00')
    expect(text).toContain('押す: ホーム')
  })

  it('clarification screen shows the question and answer/cancel hints', () => {
    const text = screens.clarificationScreenText('何時からですか?')
    expect(text).toContain('確認が必要です')
    expect(text).toContain('何時からですか?')
    expect(text).toContain('押す: 回答する')
    expect(text).toContain('二度押し: 中止')
  })

  it('followup ready/recording/captured screens have the expected hints', () => {
    expect(screens.followupReadyScreenText()).toContain('押す: 録音開始')
    expect(screens.followupRecordingScreenText()).toContain('回答を録音中')
    expect(screens.followupCapturedScreenText(5)).toContain('押す: 送信')
    expect(screens.followupCapturedScreenText(0.4)).toContain('約1秒')
  })

  it('not-calendar screen prompts the user to speak an actual schedule', () => {
    const text = screens.notCalendarScreenText()
    expect(text).toContain('話してください')
    expect(text).toContain('押す: やり直す')
  })

  it('formatCandidateWhen formats month/day and zero-padded times', () => {
    const text = screens.formatCandidateWhen({ month: 7, day: 3, hour: 9, minute: 5 }, { hour: 10, minute: 0 })
    expect(text).toBe('7/3 09:05-10:00')
  })

  it('does not interpret HTML-shaped title content (plain text only)', () => {
    const text = screens.candidateScreenText('<b>予定</b>', '7/23 15:00-16:00')
    expect(text).toContain('<b>予定</b>')
  })

  it('all screen texts stay within createStartUpPageContainer/textContainerUpgrade limits', () => {
    for (const text of ALL_SCREEN_TEXTS) {
      expect(text.length).toBeLessThanOrEqual(1000)
    }
  })
})

describe('Phase 2H product pairing screens', () => {
  it('not-connected screen prompts to start pairing and shows the exit hint', () => {
    const text = screens.notConnectedScreenText()
    expect(text).toContain('Googleカレンダーとの')
    expect(text).toContain('押す: 接続を開始')
    expect(text).toContain('二度押し: 終了')
  })

  it('pairing screen shows the verification URL, the code, and a waiting/cancel hint', () => {
    const text = screens.pairingScreenText('backend.test/connect', 'ABCD-EFGH')
    expect(text).toContain('backend.test/connect')
    expect(text).toContain('ABCD-EFGH')
    expect(text).toContain('接続待ち')
    expect(text).toContain('二度押し: 中止')
  })

  it('pairing success screen shows the menu hint', () => {
    const text = screens.pairingSuccessScreenText()
    expect(text).toContain('接続しました')
    expect(text).toContain('押す: メニューへ')
  })

  it('pairing error screens are distinct per error kind and never show the Google email', () => {
    const kinds = ['expired', 'communication_failure', 'cancelled', 'auth_failure'] as const
    const texts = kinds.map((kind) => screens.pairingErrorScreenText(kind))
    expect(new Set(texts).size).toBe(kinds.length)
    for (const text of texts) {
      expect(text).not.toContain('@')
    }
  })
})

describe('Language selection/diagnostics screens', () => {
  it('LANGUAGE_OPTIONS always shows English/Japanese in their own script regardless of the current locale', () => {
    expect(screens.LANGUAGE_OPTIONS).toEqual([
      { locale: 'en', label: 'English' },
      { locale: 'ja', label: '日本語' },
    ])
  })

  it('language screen shows both options with the cursor on the selected index', () => {
    const text = screens.languageScreenText(0)
    expect(text).toContain('> English')
    expect(text).toContain('  日本語')
    expect(text).toContain('言語')
    expect(text).toContain('二度押し: 診断情報')
  })

  it('language screen moves the cursor to the second option when selectedIndex=1', () => {
    const text = screens.languageScreenText(1)
    expect(text).toContain('  English')
    expect(text).toContain('> 日本語')
  })

  it('diagnostics screen shows all the raw signal labels and "(empty)" for missing values', () => {
    const text = screens.languageDiagnosticsScreenText({
      navigatorLanguages: '(empty)',
      navigatorLanguage: '(empty)',
      documentLang: '(empty)',
      intlLocale: 'en-US',
      stored: '(empty)',
      active: 'ja',
      deviceInfoStatus: 'fail',
      glassesInfoStatus: 'fail',
    })
    expect(text).toContain('nav.languages: (empty)')
    expect(text).toContain('nav.language: (empty)')
    expect(text).toContain('doc.lang: (empty)')
    expect(text).toContain('Intl: en-US')
    expect(text).toContain('保存値: (empty)')
    expect(text).toContain('現在: ja')
    expect(text).toContain('devInfo: fail')
    expect(text).toContain('glassesInfo: fail')
    expect(text).toContain('押す/二度押し: 戻る')
  })

  it('diagnostics screen never contains a "@" (defensive against accidentally leaking an email/account value)', () => {
    const text = screens.languageDiagnosticsScreenText({
      navigatorLanguages: 'en-US',
      navigatorLanguage: 'en-US',
      documentLang: 'en',
      intlLocale: 'en-US',
      stored: 'en',
      active: 'en',
      deviceInfoStatus: 'ok locale=(empty)',
      glassesInfoStatus: 'ok keys=model,sn,status locale=(empty)',
    })
    expect(text).not.toContain('@')
  })
})
