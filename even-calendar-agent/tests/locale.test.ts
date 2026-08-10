import { describe, expect, it } from 'vitest';
import {
  ABSENT_LOCALE_DEFAULT,
  MAX_LOCALE_LENGTH,
  UNRESOLVED_LOCALE_FALLBACK,
  localeFromBody,
  localeFromQuery,
  normalizeLocale,
  type SupportedLocale,
} from '../src/i18n/locale.js';

const CLOSED_UNION: SupportedLocale[] = ['ja', 'en'];

function expectClosedUnion(value: SupportedLocale): void {
  expect(CLOSED_UNION).toContain(value);
}

describe('normalizeLocale', () => {
  it.each(['ja', 'ja-JP', 'ja_jp', 'JA-jp'])('%s -> ja', (input) => {
    expect(normalizeLocale(input)).toBe('ja');
  });

  it.each(['en', 'en-US', 'en_GB', 'EN-us'])('%s -> en', (input) => {
    expect(normalizeLocale(input)).toBe('en');
  });

  it.each(['fr', 'zh-TW'])('unsupported tag %s -> en', (input) => {
    expect(normalizeLocale(input)).toBe('en');
  });

  it('empty string -> en', () => {
    expect(normalizeLocale('')).toBe('en');
  });

  it('whitespace-only string -> en', () => {
    expect(normalizeLocale('   ')).toBe('en');
  });

  it(`string longer than ${MAX_LOCALE_LENGTH} chars -> en`, () => {
    expect(normalizeLocale('a'.repeat(MAX_LOCALE_LENGTH + 1))).toBe('en');
  });

  it('number -> en', () => {
    expect(normalizeLocale(42)).toBe('en');
  });

  it('object -> en', () => {
    expect(normalizeLocale({})).toBe('en');
  });

  it('array -> en', () => {
    expect(normalizeLocale(['ja', 'en'])).toBe('en');
  });

  it('null -> en', () => {
    expect(normalizeLocale(null)).toBe('en');
  });

  it('undefined -> en', () => {
    expect(normalizeLocale(undefined)).toBe('en');
  });

  it('injection-like string -> en, never throws', () => {
    expect(() => normalizeLocale('"; DROP TABLE events; --')).not.toThrow();
    expect(normalizeLocale('"; DROP TABLE events; --')).toBe('en');
  });

  it('never throws and always returns a closed 2-value union', () => {
    const inputs: unknown[] = ['ja', 'en', 'fr', '', null, undefined, 42, {}, [], NaN, Symbol('x'), () => {}];
    for (const input of inputs) {
      let result: SupportedLocale | undefined;
      expect(() => {
        result = normalizeLocale(input);
      }).not.toThrow();
      expectClosedUnion(result as SupportedLocale);
    }
  });
});

describe('localeFromQuery', () => {
  it('key absent -> ja', () => {
    expect(localeFromQuery({})).toBe(ABSENT_LOCALE_DEFAULT);
  });

  it('{locale: "en"} -> en', () => {
    expect(localeFromQuery({ locale: 'en' })).toBe('en');
  });

  it('{locale: ""} -> en (present but unresolvable)', () => {
    expect(localeFromQuery({ locale: '' })).toBe(UNRESOLVED_LOCALE_FALLBACK);
  });

  it('{locale: ["ja","en"]} (Express-style duplicated query param) -> en', () => {
    expect(localeFromQuery({ locale: ['ja', 'en'] })).toBe(UNRESOLVED_LOCALE_FALLBACK);
  });

  it('{locale: 42} -> en', () => {
    expect(localeFromQuery({ locale: 42 })).toBe(UNRESOLVED_LOCALE_FALLBACK);
  });

  it('non-object query (null/undefined/primitive) -> ja', () => {
    expect(localeFromQuery(null)).toBe(ABSENT_LOCALE_DEFAULT);
    expect(localeFromQuery(undefined)).toBe(ABSENT_LOCALE_DEFAULT);
    expect(localeFromQuery('nope')).toBe(ABSENT_LOCALE_DEFAULT);
  });
});

describe('localeFromBody', () => {
  it('key absent -> ja', () => {
    expect(localeFromBody({})).toBe(ABSENT_LOCALE_DEFAULT);
  });

  it('{locale: "en"} -> en', () => {
    expect(localeFromBody({ locale: 'en' })).toBe('en');
  });

  it('{locale: null} -> en (present but unresolvable)', () => {
    expect(localeFromBody({ locale: null })).toBe(UNRESOLVED_LOCALE_FALLBACK);
  });

  it('{locale: []} -> en', () => {
    expect(localeFromBody({ locale: [] })).toBe(UNRESOLVED_LOCALE_FALLBACK);
  });

  it('raw WAV Buffer body -> ja (audio routes must use localeFromQuery, not this)', () => {
    expect(localeFromBody(Buffer.from('RIFF....WAVEfmt ', 'utf8'))).toBe(ABSENT_LOCALE_DEFAULT);
  });

  it('non-object body (null/undefined/primitive) -> ja', () => {
    expect(localeFromBody(null)).toBe(ABSENT_LOCALE_DEFAULT);
    expect(localeFromBody(undefined)).toBe(ABSENT_LOCALE_DEFAULT);
    expect(localeFromBody(7)).toBe(ABSENT_LOCALE_DEFAULT);
  });
});
