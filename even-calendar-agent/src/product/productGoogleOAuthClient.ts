import { CodeChallengeMethod, type GenerateAuthUrlOpts } from 'google-auth-library';
import { createOAuth2Client, type GoogleOAuthConfig, type OAuth2Client } from '../auth/googleOAuthClient.js';
import { PRODUCT_OAUTH_SCOPES } from './productOAuthConfig.js';

export interface BuildProductAuthUrlParams {
  state: string;
  codeChallenge: string;
  nonce: string;
}

type GenerateAuthUrlOptsWithNonce = GenerateAuthUrlOpts & { nonce?: string };

/** PKCE(S256)+nonce付きの製品用Google認可URLを組み立てる。既存dev用buildAuthorizationUrlとは分離。 */
export function buildProductAuthorizationUrl(client: OAuth2Client, params: BuildProductAuthUrlParams): string {
  const opts: GenerateAuthUrlOptsWithNonce = {
    access_type: 'offline',
    scope: [...PRODUCT_OAUTH_SCOPES],
    include_granted_scopes: false,
    prompt: 'consent',
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    nonce: params.nonce,
  };
  return client.generateAuthUrl(opts);
}

export interface ProductExchangeResult {
  refreshToken: string | null;
  googleSubject: string | null;
}

export type ProductExchangeFn = (config: GoogleOAuthConfig, code: string, codeVerifier: string) => Promise<ProductExchangeResult>;

/**
 * 認可コード+PKCE code_verifierをトークンへ交換し、id_tokenを検証してGoogle subject(sub)を取得する。
 * access/refresh/ID tokenはこの関数の外(呼び出し側)へ生値のまま渡さない設計にすること
 * (refreshTokenは暗号化保存、googleSubjectは即座にハッシュ化して使う)。
 */
export async function defaultProductExchange(
  config: GoogleOAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<ProductExchangeResult> {
  const client = createOAuth2Client(config);
  const { tokens } = await client.getToken({ code, codeVerifier });
  client.setCredentials(tokens);

  let googleSubject: string | null = null;
  if (tokens.id_token) {
    try {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
      const payload = ticket.getPayload();
      googleSubject = payload?.sub ?? null;
    } catch {
      googleSubject = null;
    }
  }

  return { refreshToken: tokens.refresh_token ?? null, googleSubject };
}
