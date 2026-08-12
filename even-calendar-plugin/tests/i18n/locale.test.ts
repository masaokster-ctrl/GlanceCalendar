import { afterEach, describe, expect, it } from 'vitest'
import { detectLocale, getActiveLocale, resetActiveLocaleForTest, setActiveLocale } from '../../src/i18n/locale'

describe('detectLocale', () => {
  it('prefers deviceLocale over everything else, including an explicit stored selection', () => {
    expect(detectLocale({ deviceLocale: 'ja-JP', stored: 'en', navigatorLanguages: ['en-US'] })).toBe('ja')
    expect(detectLocale({ deviceLocale: 'en-US', stored: 'ja', navigatorLanguages: ['ja-JP'] })).toBe('en')
  })

  it('falls back past an unsupported/invalid deviceLocale to the next signal', () => {
    expect(detectLocale({ deviceLocale: 'fr-FR', stored: 'en', navigatorLanguages: ['ja-JP'] })).toBe('en')
    expect(detectLocale({ deviceLocale: '', stored: 'en', navigatorLanguages: ['ja-JP'] })).toBe('en')
    expect(detectLocale({ deviceLocale: null, stored: 'en', navigatorLanguages: ['ja-JP'] })).toBe('en')
    expect(detectLocale({ deviceLocale: undefined, stored: 'en', navigatorLanguages: ['ja-JP'] })).toBe('en')
  })

  it('resolves the primary subtag of deviceLocale (ja_JP -> ja, en-US -> en)', () => {
    expect(detectLocale({ deviceLocale: 'ja_JP', stored: 'en', navigatorLanguages: [] })).toBe('ja')
    expect(detectLocale({ deviceLocale: 'en-US', stored: 'ja', navigatorLanguages: [] })).toBe('en')
  })

  it('prefers stored (explicit selection) over navigatorLanguages when deviceLocale is absent', () => {
    // 新仕様: Language画面での明示的な選択(stored)は、信頼性が未確認のnavigator検出結果より優先される。
    expect(detectLocale({ stored: 'en', navigatorLanguages: ['ja-JP'] })).toBe('en')
    expect(detectLocale({ stored: 'ja', navigatorLanguages: ['en-US'] })).toBe('ja')
  })

  it('ignores an unsupported/invalid stored value and falls back to navigatorLanguages', () => {
    expect(detectLocale({ stored: 'fr', navigatorLanguages: ['en-US'] })).toBe('en')
    expect(detectLocale({ stored: '', navigatorLanguages: ['en-US'] })).toBe('en')
    expect(detectLocale({ stored: null, navigatorLanguages: ['en-US'] })).toBe('en')
    expect(detectLocale({ stored: undefined, navigatorLanguages: ['en-US'] })).toBe('en')
  })

  it('resolves the primary subtag of the first navigator language entry (en-US -> en)', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: ['en-US', 'fr'] })).toBe('en')
  })

  it('resolves ja_JP style tags (underscore separator) to ja', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: ['ja_JP'] })).toBe('ja')
  })

  it('falls back to ja for an unsupported primary language (fr) when nothing else is usable', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: ['fr'] })).toBe('ja')
  })

  it('falls back to ja for an empty navigatorLanguages array when nothing else is usable', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: [] })).toBe('ja')
  })

  it('falls back to ja when navigatorLanguages is undefined/null and nothing else is usable', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: undefined })).toBe('ja')
    expect(detectLocale({ stored: null, navigatorLanguages: null })).toBe('ja')
  })

  it('falls back to ja when stored, navigatorLanguages and navigatorLanguage are all absent', () => {
    expect(detectLocale({ stored: undefined, navigatorLanguages: undefined })).toBe('ja')
  })

  it('uses navigatorLanguage (singular) when navigatorLanguages is empty/undefined/null, regardless of stored', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: [], navigatorLanguage: 'en-US' })).toBe('en')
    expect(detectLocale({ stored: null, navigatorLanguages: undefined, navigatorLanguage: 'en-US' })).toBe('en')
    expect(detectLocale({ stored: null, navigatorLanguages: null, navigatorLanguage: 'en-US' })).toBe('en')
  })

  it('uses stored over navigatorLanguage (singular) when stored is present', () => {
    expect(detectLocale({ stored: 'ja', navigatorLanguages: [], navigatorLanguage: 'en-US' })).toBe('ja')
  })

  it('falls back to ja when nothing at all is usable (deviceLocale, stored, navigatorLanguages, navigatorLanguage)', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: null, navigatorLanguage: null })).toBe('ja')
    expect(detectLocale({ stored: undefined, navigatorLanguages: undefined, navigatorLanguage: undefined })).toBe('ja')
    expect(
      detectLocale({ deviceLocale: null, stored: undefined, navigatorLanguages: undefined, navigatorLanguage: undefined }),
    ).toBe('ja')
  })
})

describe('active locale module state', () => {
  afterEach(() => {
    resetActiveLocaleForTest()
  })

  it('defaults to ja', () => {
    expect(getActiveLocale()).toBe('ja')
  })

  it('setActiveLocale updates the value read by getActiveLocale', () => {
    setActiveLocale('en')
    expect(getActiveLocale()).toBe('en')
  })

  it('resetActiveLocaleForTest restores the ja default', () => {
    setActiveLocale('en')
    resetActiveLocaleForTest()
    expect(getActiveLocale()).toBe('ja')
  })
})
