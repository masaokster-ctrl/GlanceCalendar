import { hkdfSync } from 'node:crypto';

export type ProductSigningContext = 'browser-session-v1' | 'csrf-v1' | 'oauth-state-v1';

export class SigningKeyNotConfiguredError extends Error {
  constructor() {
    super('product browser signing key is not configured');
    this.name = 'SigningKeyNotConfiguredError';
  }
}

/**
 * setupAdminToken(devセッション発行専用)とは完全に独立した専用master keyから、用途別のsubkeyを
 * HKDFで導出する。同一鍵材料をbrowser session cookie/CSRF/OAuth stateへ直接使い回さないための分離。
 * master keyが未設定の環境ではavailable=falseとなり、呼び出し側は503を返すこと。
 */
export class ProductSigningKeyProvider {
  constructor(private readonly masterKey: string | null) {}

  get available(): boolean {
    return this.masterKey !== null;
  }

  subkey(context: ProductSigningContext): string {
    if (this.masterKey === null) {
      throw new SigningKeyNotConfiguredError();
    }
    const derived = hkdfSync('sha256', Buffer.from(this.masterKey, 'utf8'), Buffer.alloc(0), Buffer.from(context, 'utf8'), 32);
    return Buffer.from(derived).toString('hex');
  }
}
