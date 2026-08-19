import 'dotenv/config';
import { GoogleAuth } from 'google-auth-library';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { google } from 'googleapis';
import { createApp } from './app.js';
import { createFirestoreClient } from './firestore/firestoreClient.js';
import { FirestoreConversationStateRepository } from './firestore/conversationStateRepository.js';
import { FirestoreIdempotencyRepository } from './firestore/idempotencyRepository.js';
import { FirestoreDeliveryDedupeRepository } from './firestore/deliveryDedupeRepository.js';
import { FirestorePluginSessionRepository } from './firestore/pluginSessionRepository.js';
import { FirestorePluginRateLimitRepository } from './firestore/pluginRateLimitRepository.js';
import { FirestorePluginRequestDedupeRepository } from './firestore/pluginRequestDedupeRepository.js';
import { FirestorePluginEventCandidateRepository } from './firestore/pluginEventCandidateRepository.js';
import { FirestorePluginConversationRepository } from './firestore/pluginConversationRepository.js';
import { SecretManagerRefreshTokenStore } from './auth/refreshTokenStore.js';
import { createInMemoryOAuthVerificationTracker } from './auth/oauthVerificationTracker.js';
import { createOAuth2Client, type GoogleOAuthConfig } from './auth/googleOAuthClient.js';
import { GoogleCalendarClient } from './calendar/calendarClient.js';
import { createCalendarService } from './calendar/calendarService.js';
import { systemClock } from './time/clock.js';
import { VertexGeminiClient } from './gemini/geminiClient.js';
import { FirestoreProductPairingRepository } from './product/productPairingRepository.js';
import { FirestoreProductInstallationRepository } from './product/productInstallationRepository.js';
import { FirestoreProductUserRepository } from './product/productUserRepository.js';
import { FirestoreProductDeviceRefreshTokenRepository } from './product/productDeviceRefreshTokenRepository.js';
import { FirestoreProductAuditRepository } from './product/productAuditRepository.js';
import { FirestoreProductExchangeCoordinator } from './product/productExchangeCoordinator.js';
import { FirestoreGoogleCredentialRepository } from './product/productGoogleCredentialRepository.js';
import { CloudKmsGoogleCredentialCipher, NotConfiguredGoogleCredentialCipher, type GoogleCredentialCipher } from './product/googleCredentialCipher.js';
import { ProductSigningKeyProvider } from './product/productSigningKey.js';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { createCalendarServiceResolver } from './product/calendarServiceResolver.js';

const DEFAULT_PORT = 8080;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_CALENDAR_ID = 'primary';
const DEFAULT_FIRESTORE_DATABASE_ID = '(default)';
const DEFAULT_REFRESH_TOKEN_SECRET_NAME = 'google-calendar-refresh-token';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_VERTEX_LOCATION = 'asia-northeast1';

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    console.error(JSON.stringify({ level: 'error', event: 'startup_failed', reason: `${name} is not set` }));
    process.exit(1);
  }
  return value;
}

const port = Number(process.env.PORT ?? DEFAULT_PORT);
const resolvedAgentToken = requireEnv('EVEN_AGENT_TOKEN', process.env.EVEN_AGENT_TOKEN);
const resolvedSetupAdminToken = requireEnv('SETUP_ADMIN_TOKEN', process.env.SETUP_ADMIN_TOKEN);
const resolvedOAuthClientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID', process.env.GOOGLE_OAUTH_CLIENT_ID);
const resolvedOAuthClientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET', process.env.GOOGLE_OAUTH_CLIENT_SECRET);
const resolvedOAuthRedirectUri = requireEnv('GOOGLE_OAUTH_REDIRECT_URI', process.env.GOOGLE_OAUTH_REDIRECT_URI);

const calendarId = process.env.CALENDAR_ID ?? DEFAULT_CALENDAR_ID;
const firestoreDatabaseId = process.env.FIRESTORE_DATABASE_ID ?? DEFAULT_FIRESTORE_DATABASE_ID;
const enableProbeTests = process.env.ENABLE_PROBE_TESTS === 'true';
const refreshTokenSecretName = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN_SECRET ?? DEFAULT_REFRESH_TOKEN_SECRET_NAME;
const geminiModel = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
const vertexLocation = process.env.VERTEX_LOCATION ?? DEFAULT_VERTEX_LOCATION;

const oauthConfig: GoogleOAuthConfig = {
  clientId: resolvedOAuthClientId,
  clientSecret: resolvedOAuthClientSecret,
  redirectUri: resolvedOAuthRedirectUri,
};

const googleAuth = new GoogleAuth();
const projectId = await googleAuth.getProjectId();

const firestore = createFirestoreClient({ projectId, databaseId: firestoreDatabaseId });
const secretManagerClient = new SecretManagerServiceClient();

const refreshTokenStore = new SecretManagerRefreshTokenStore({
  client: secretManagerClient,
  projectId,
  secretName: refreshTokenSecretName,
  clock: systemClock,
});

const verificationTracker = createInMemoryOAuthVerificationTracker();

// Gemini API keyは使用しない。vertexai:true + project/locationのみを指定し、
// Cloud Run実行サービスアカウントのApplication Default Credentialsで認証する。
const geminiClient = new VertexGeminiClient({ project: projectId, location: vertexLocation, model: geminiModel });

// PRODUCT_GOOGLE_CREDENTIAL_KMS_KEY が未設定の環境では暗号化は "not configured" のまま。
// productユーザーのGoogle credential保存はEncryptionNotConfiguredErrorで503を返し、平文fallbackはしない。
const productGoogleCredentialKmsKey = process.env.PRODUCT_GOOGLE_CREDENTIAL_KMS_KEY;
const productCredentialCipher: GoogleCredentialCipher = productGoogleCredentialKmsKey
  ? new CloudKmsGoogleCredentialCipher(productGoogleCredentialKmsKey, new KeyManagementServiceClient())
  : new NotConfiguredGoogleCredentialCipher();
const productCredentialRepo = new FirestoreGoogleCredentialRepository(firestore, productCredentialCipher);

// PRODUCT_BROWSER_SIGNING_KEY が未設定の環境ではavailable=falseとなり、connect page/product OAuthは503を返す。
// setupAdminToken(dev session発行専用)とは完全に独立した専用鍵。
const productSigningKeyProvider = new ProductSigningKeyProvider(process.env.PRODUCT_BROWSER_SIGNING_KEY ?? null);

// devのoauthConfigとは別の製品用Google OAuth client。3つ全て揃わない限りproduct OAuthは503を返す
// (dev OAuthはconfig.oauthConfigのまま一切変更しない)。
const productOAuthClientId = process.env.PRODUCT_GOOGLE_OAUTH_CLIENT_ID;
const productOAuthClientSecret = process.env.PRODUCT_GOOGLE_OAUTH_CLIENT_SECRET;
const productOAuthRedirectUriEnv = process.env.PRODUCT_GOOGLE_OAUTH_REDIRECT_URI;
const productOAuthConfig: GoogleOAuthConfig | null =
  productOAuthClientId && productOAuthClientSecret && productOAuthRedirectUriEnv
    ? { clientId: productOAuthClientId, clientSecret: productOAuthClientSecret, redirectUri: productOAuthRedirectUriEnv }
    : null;
const productPairingRepo = new FirestoreProductPairingRepository(firestore);
const productInstallationRepo = new FirestoreProductInstallationRepository(firestore);
const productUserRepo = new FirestoreProductUserRepository(firestore);
const productDeviceRefreshTokenRepo = new FirestoreProductDeviceRefreshTokenRepository(firestore);
const productAuditRepo = new FirestoreProductAuditRepository(firestore);
const productExchangeCoordinator = new FirestoreProductExchangeCoordinator(firestore);

const resolveCalendarService = createCalendarServiceResolver({
  productOAuthConfig,
  productCredentialRepo,
  devOAuthConfig: oauthConfig,
  getDevRefreshToken: () => refreshTokenStore.getRefreshToken(),
  buildCalendarService: (config, refreshToken) => {
    const client = createOAuth2Client(config);
    client.setCredentials({ refresh_token: refreshToken });
    const calendar = google.calendar({ version: 'v3', auth: client });
    return createCalendarService(new GoogleCalendarClient(calendar));
  },
});

const app = createApp({
  agentToken: resolvedAgentToken,
  setupAdminToken: resolvedSetupAdminToken,
  oauthConfig,
  enableProbeTests,
  calendarId,
  conversationStateRepo: new FirestoreConversationStateRepository(firestore),
  idempotencyRepo: new FirestoreIdempotencyRepository(firestore),
  deliveryDedupeRepo: new FirestoreDeliveryDedupeRepository(firestore),
  refreshTokenStore,
  verificationTracker,
  resolveCalendarService,
  pluginSessionRepo: new FirestorePluginSessionRepository(firestore),
  pluginRateLimitRepo: new FirestorePluginRateLimitRepository(firestore),
  pluginRequestDedupeRepo: new FirestorePluginRequestDedupeRepository(firestore),
  pluginEventCandidateRepo: new FirestorePluginEventCandidateRepository(firestore),
  pluginConversationRepo: new FirestorePluginConversationRepository(firestore),
  geminiClient,
  geminiModel,
  vertexLocation,
  productPairingRepo,
  productInstallationRepo,
  productUserRepo,
  productDeviceRefreshTokenRepo,
  productAuditRepo,
  productExchangeCoordinator,
  productCredentialRepo,
  productCredentialCipher,
  productSigningKeyProvider,
  productOAuthConfig,
});

const server = app.listen(port, () => {
  console.log(JSON.stringify({ level: 'info', event: 'server_started', port }));
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));

  server.close((err) => {
    if (err) {
      console.error(JSON.stringify({ level: 'error', event: 'shutdown_error' }));
      process.exit(1);
      return;
    }
    console.log(JSON.stringify({ level: 'info', event: 'shutdown_complete' }));
    process.exit(0);
  });

  setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', event: 'shutdown_timeout_forced' }));
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
