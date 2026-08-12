import { afterEach, describe, expect, it } from 'vitest'
import { detectLocale, getActiveLocale, resetActiveLocaleForTest, setActiveLocale } from '../../src/i18n/locale'

describe('detectLocale', () => {
  it('prefers navigatorLanguages over stored, regardless of what stored contains', () => {
    // 新仕様: 明示的な言語選択UIが存在しない現状、storedは「navigatorが使えない場合のみの
    // フォールバック」であり、ライブのnavigatorLanguages検出結果を上書きしてはならない。
    expect(detectLocale({ stored: 'en', navigatorLanguages: ['ja-JP'] })).toBe('ja')
    expect(detectLocale({ stored: 'ja', navigatorLanguages: ['en-US'] })).toBe('en')
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
    expect(detectLocale({ stored: 'ja', navigatorLanguages: [], navigatorLanguage: 'en-US' })).toBe('en')
    expect(detectLocale({ stored: 'ja', navigatorLanguages: undefined, navigatorLanguage: 'en-US' })).toBe('en')
    expect(detectLocale({ stored: 'ja', navigatorLanguages: null, navigatorLanguage: 'en-US' })).toBe('en')
  })

  it('uses stored only when neither navigatorLanguages nor navigatorLanguage is usable', () => {
    expect(detectLocale({ stored: 'en', navigatorLanguages: null, navigatorLanguage: null })).toBe('en')
    expect(detectLocale({ stored: 'en', navigatorLanguages: [], navigatorLanguage: undefined })).toBe('en')
    expect(detectLocale({ stored: 'en', navigatorLanguages: ['fr'], navigatorLanguage: 'fr' })).toBe('en')
  })

  it('falls back to ja when nothing at all is usable (navigatorLanguages, navigatorLanguage, stored)', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: null, navigatorLanguage: null })).toBe('ja')
    expect(detectLocale({ stored: undefined, navigatorLanguages: undefined, navigatorLanguage: undefined })).toBe('ja')
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
