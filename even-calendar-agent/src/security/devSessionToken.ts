import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;

/** 暗号学的に安全なランダムトークンを生成する(16進64文字)。 */
export function generateDevSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** トークンのSHA-256ハッシュ(16進)。Firestoreにはこの値のみを保存する。 */
export function hashDevSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** installId等、生値をFirestore/ログへ残したくない任意文字列の汎用SHA-256ハッシュ(16進)。 */
export function hashValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** ログへ安全に出せる短いprefix(先頭8文字)のみを返す。 */
export function shortHashPrefix(hash: string): string {
  return hash.slice(0, 8);
}
