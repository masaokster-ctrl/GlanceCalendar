import { createApp, type AppConfig } from '../src/app.js';
import type { GoogleOAuthConfig } from '../src/auth/googleOAuthClient.js';
import { ProductSigningKeyProvider } from '../src/product/productSigningKey.js';

export const TEST_AGENT_TOKEN = 'test-token';
export const TEST_SETUP_ADMIN_TOKEN = 'test-setup-admin-token-0123456789abcdef';
export const TEST_OAUTH_CONFIG: GoogleOAuthConfig = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://example.test/oauth2/callback',
};
/** devのTEST_OAUTH_CONFIGとは意図的に別のclient id/secret/redirectUriにし、分離を検証しやすくする。 */
export const TEST_PRODUCT_OAUTH_CONFIG: GoogleOAuthConfig = {
  clientId: 'test-product-client-id.apps.googleusercontent.com',
  clientSecret: 'test-product-client-secret',
  redirectUri: 'https://example.test/product/oauth/google/callback',
};
export const TEST_PRODUCT_SIGNING_KEY = 'test-product-browser-signing-key-0123456789abcdef-not-setup-admin';

export function createTestApp(overrides: Partial<AppConfig> = {}): ReturnType<typeof createApp> {
  return createApp({
    agentToken: TEST_AGENT_TOKEN,
    setupAdminToken: TEST_SETUP_ADMIN_TOKEN,
    oauthConfig: TEST_OAUTH_CONFIG,
    productOAuthConfig: TEST_PRODUCT_OAUTH_CONFIG,
    productSigningKeyProvider: new ProductSigningKeyProvider(TEST_PRODUCT_SIGNING_KEY),
    ...overrides,
  });
}

/** supertestのレスポンスの set-cookie 配列から、指定した名前のCookieの "name=value" 部分だけを取り出す。 */
export function extractCookie(setCookieHeader: string[] | undefined, name: string): string | undefined {
  const line = setCookieHeader?.find((c) => c.startsWith(`${name}=`));
  return line?.split(';')[0];
}
