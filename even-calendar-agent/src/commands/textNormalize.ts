const PUNCTUATION_CHARS = /[。、！？!?.,]/g;
const WHITESPACE_RUN = /[\s\u3000]+/g;

/**
 * Unicode正規化(NFKC、全角/半角数字の吸収を含む)・句読点除去・
 * 連続空白の1個への統合・前後空白除去を行う。
 */
export function normalizeUtterance(input: string): string {
  const nfkc = input.normalize('NFKC');
  const withoutPunctuation = nfkc.replace(PUNCTUATION_CHARS, '');
  return withoutPunctuation.replace(WHITESPACE_RUN, ' ').trim();
}

/** 「午後3時」のような表現を24時間制の「15時」表記へ変換する(正規化後の文字列に対して使用)。 */
export function convertAfternoonHour(input: string): string {
  return input.replace(/午後\s*(\d{1,2})時/g, (_match, hourText: string) => {
    const hour = Number(hourText);
    const converted = hour === 12 ? 12 : hour + 12;
    return `${converted}時`;
  });
}
