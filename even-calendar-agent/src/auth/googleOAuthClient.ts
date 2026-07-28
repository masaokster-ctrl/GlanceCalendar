import { google } from 'googleapis';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';

// googleapis が内部で使う google-auth-library の型と、直接importした google-auth-library の型が
// (google-gax 経由の別バージョンにより)一致しないため、google.auth.OAuth2 自身からインスタンス型を導出する。
export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createOAuth2Client(config: GoogleOAuthConfig): OAuth2Client {
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

export function buildAuthorizationUrl(client: OAuth2Client, state: string): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [CALENDAR_SCOPE],
    include_granted_scopes: true,
    prompt: 'consent',
    state,
  });
}

export interface TokenExchangeResult {
  refreshToken: string | null;
}

/** 認可コードをトークンへ交換する。access token / refresh tokenをログへ出さない。 */
export async function exchangeCodeForTokens(client: OAuth2Client, code: string): Promise<TokenExchangeResult> {
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  return { refreshToken: tokens.refresh_token ?? null };
}
