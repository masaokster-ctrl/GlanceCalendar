import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedTokenPayload {
  [key: string]: string | number;
}

function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * ペイロードをBase64url化しHMAC署名を付けた、ステートレスな署名付きトークンを生成する。
 * secret自体はトークンに含めない。サーバー側の秘密鍵でのみ検証できる。
 */
export function createSignedToken(secret: string, payload: SignedTokenPayload, expiresAtMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: expiresAtMs }), 'utf8').toString('base64url');
  const signature = hmac(secret, body);
  return `${body}.${signature}`;
}

export function verifySignedToken<T extends SignedTokenPayload = SignedTokenPayload>(
  secret: string,
  token: string,
  nowMs: number,
): (T & { exp: number }) | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [body, signature] = parts as [string, string];
  const expectedSignature = hmac(secret, body);

  const sigBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null || typeof (payload as Record<string, unknown>).exp !== 'number') {
    return null;
  }

  const parsed = payload as T & { exp: number };
  if (parsed.exp < nowMs) {
    return null;
  }

  return parsed;
}
