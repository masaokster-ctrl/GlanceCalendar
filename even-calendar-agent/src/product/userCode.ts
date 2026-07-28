import { randomInt } from 'node:crypto';

// 紛らわしい 0/O, 1/I, 8/B, 5/S 等を避けた英数字。CSPRNG(node:crypto.randomInt)で生成する。
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY379';
const CODE_CHAR_COUNT = 8;

/** "ABCD-EFGH" 形式のペアリングコードを生成する。生値はレスポンスで一度だけ返し、保存しない。 */
export function generateUserCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_CHAR_COUNT; i += 1) {
    raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** ユーザー入力を比較可能な正規形へ(大文字化・ハイフン/空白除去・許可文字以外を除去)。 */
export function normalizeUserCodeInput(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}
