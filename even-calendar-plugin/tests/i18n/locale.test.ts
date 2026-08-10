import { afterEach, describe, expect, it } from 'vitest'
import { detectLocale, getActiveLocale, resetActiveLocaleForTest, setActiveLocale } from '../../src/i18n/locale'

describe('detectLocale', () => {
  it('prefers a valid stored locale over navigatorLanguages', () => {
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

  it('falls back to ja for an unsupported primary language (fr)', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: ['fr'] })).toBe('ja')
  })

  it('falls back to ja for an empty navigatorLanguages array', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: [] })).toBe('ja')
  })

  it('falls back to ja when navigatorLanguages is undefined/null', () => {
    expect(detectLocale({ stored: null, navigatorLanguages: undefined })).toBe('ja')
    expect(detectLocale({ stored: null, navigatorLanguages: null })).toBe('ja')
  })

  it('falls back to ja when both stored and navigatorLanguages are absent', () => {
    expect(detectLocale({ stored: undefined, navigatorLanguages: undefined })).toBe('ja')
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
