import express, { type Express, type Request } from 'express';
import helmet from 'helmet';
import { createChatCompletionsRouter } from './routes/chatCompletions.js';
import { healthRouter } from './routes/health.js';
import { privacyRouter } from './routes/privacy.js';
import { createSetupRouter } from './routes/setup.js';
import { createOAuthRouter, type ExchangeAndVerifyFn } from './routes/oauth.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import type { RequestWithRawBodyLength } from './middleware/requestMetadataLogger.js';
import type { DelayFn } from './utils/delay.js';
import { systemClock, type Clock } from './time/clock.js';
import {
  InMemoryConversationStateRepository,
  type ConversationStateRepository,
} from './firestore/conversationStateRepository.js';
import { InMemoryIdempotencyRepository, type IdempotencyRepository } from './firestore/idempotencyRepository.js';
import {
  InMemoryDeliveryDedupeRepository,
  type DeliveryDedupeRepository,
} from './firestore/deliveryDedupeRepository.js';
import type { CalendarService } from './calendar/calendarService.js';
import { InMemoryRefreshTokenStore, type RefreshTokenStore } from './auth/refreshTokenStore.js';
import {
  createInMemoryOAuthVerificationTracker,
  type OAuthVerificationTracker,
} from './auth/oauthVerificationTracker.js';
import type { GoogleOAuthConfig } from './auth/googleOAuthClient.js';
import { createPluginDevSessionsRouter } from './routes/pluginDevSessions.js';
import { createPluginAnalyzeAudioRouter } from './routes/pluginAnalyzeAudio.js';
import { createPluginCalendarEventsRouter } from './routes/pluginCalendarEvents.js';
import { createPluginCalendarEventsDayRouter } from './routes/pluginCalendarEventsDay.js';
import { createPluginCalendarEventsUpcomingRouter } from './routes/pluginCalendarEventsUpcoming.js';
import { createPluginCalendarEventsItemRouter } from './routes/pluginCalendarEventsItem.js';
import { InMemoryPluginSessionRepository, type PluginSessionRepository } from './firestore/pluginSessionRepository.js';
import {
  InMemoryPluginRateLimitRepository,
  type PluginRateLimitRepository,
} from './firestore/pluginRateLimitRepository.js';
import {
  InMemoryPluginRequestDedupeRepository,
  type PluginRequestDedupeRepository,
} from './firestore/pluginRequestDedupeRepository.js';
import {
  InMemoryPluginEventCandidateRepository,
  type PluginEventCandidateRepository,
} from './firestore/pluginEventCandidateRepository.js';
import {
  InMemoryPluginConversationRepository,
  type PluginConversationRepository,
} from './firestore/pluginConversationRepository.js';
import { createPluginAnalyzeFollowupAudioRouter } from './routes/pluginAnalyzeFollowupAudio.js';
import { createPluginAnalyzeEditAudioRouter } from './routes/pluginAnalyzeEditAudio.js';
import { createPluginConversationsCancelRouter } from './routes/pluginConversationsCancel.js';
import { FakeGeminiClient, type GeminiClient } from './gemini/geminiClient.js';
import { createProductPairingsRouter } from './routes/productPairings.js';
import { createProductConnectPageRouter } from './routes/productConnectPage.js';
import { createProductOAuthRouter } from './routes/productOAuth.js';
import { createProductSessionsRouter } from './routes/productSessions.js';
import { InMemoryProductPairingRepository, type ProductPairingRepository } from './product/productPairingRepository.js';
import {
  InMemoryProductInstallationRepository,
  type ProductInstallationRepository,
} from './product/productInstallationRepository.js';
import { InMemoryProductUserRepository, type ProductUserRepository } from './product/productUserRepository.js';
import {
  InMemoryProductDeviceRefreshTokenRepository,
  type ProductDeviceRefreshTokenRepository,
} from './product/productDeviceRefreshTokenRepository.js';
import { InMemoryProductAuditRepository, type ProductAuditRepository } from './product/productAuditRepository.js';
import { InMemoryProductExchangeCoordinator, type ProductExchangeCoordinator } from './product/productExchangeCoordinator.js';
import {
  InMemoryGoogleCredentialRepository,
  type GoogleCredentialRepository,
} from './product/productGoogleCredentialRepository.js';
import { NotConfiguredGoogleCredentialCipher, type GoogleCredentialCipher } from './product/googleCredentialCipher.js';
import type { ProductExchangeFn } from './product/productGoogleOAuthClient.js';
import { ProductSigningKeyProvider } from './product/productSigningKey.js';

const JSON_BODY_LIMIT = '1mb';
const FORM_BODY_LIMIT = '10kb';
const DEFAULT_CALENDAR_ID = 'primary';
const DEFAULT_USER_ID = 'single-user';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_VERTEX_LOCATION = 'asia-northeast1';

export interface AppConfig {
  agentToken: string;
  setupAdminToken: string;
  oauthConfig: GoogleOAuthConfig;
  delayFn?: DelayFn;
  enableProbeTests?: boolean;
  clock?: Clock;
  userId?: string;
  calendarId?: string;
  conversationStateRepo?: ConversationStateRepository;
  idempotencyRepo?: IdempotencyRepository;
  deliveryDedupeRepo?: DeliveryDedupeRepository;
  /**
   * userIdがnull(dev session由来)の場合は既存の単一Google管理者アカウント(Secret Manager)を使う。
   * userIdが渡された場合(device session由来)はそのuserId固有のproductGoogleCredentialsを使う。
   * 既存のdev専用テストは引数を無視する形のままでも型上そのまま利用できる。
   */
  resolveCalendarService?: (userId?: string | null) => Promise<CalendarService | null>;
  refreshTokenStore?: RefreshTokenStore;
  verificationTracker?: OAuthVerificationTracker;
  exchangeAndVerifyFn?: ExchangeAndVerifyFn;
  pluginSessionRepo?: PluginSessionRepository;
  pluginRateLimitRepo?: PluginRateLimitRepository;
  pluginRequestDedupeRepo?: PluginRequestDedupeRepository;
  pluginEventCandidateRepo?: PluginEventCandidateRepository;
  pluginConversationRepo?: PluginConversationRepository;
  geminiClient?: GeminiClient;
  geminiModel?: string;
  vertexLocation?: string;
  geminiTimeoutMs?: number;
  candidateTtlMs?: number;
  conversationTtlMs?: number;
  followupLeaseDurationMs?: number;
  calendarEventsDayRateLimitPerMinute?: number;
  calendarEventsDayTimeoutMs?: number;
  calendarEventsUpcomingRateLimitPerMinute?: number;
  calendarEventsUpcomingTimeoutMs?: number;
  calendarEventsItemRateLimitPerMinute?: number;
  calendarEventsItemTimeoutMs?: number;
  analyzeEditAudioRateLimitPerMinute?: number;
  analyzeEditAudioCalendarTimeoutMs?: number;
  // Phase 2H: 製品用ペアリング・OAuth・device session基盤
  productPairingRepo?: ProductPairingRepository;
  productInstallationRepo?: ProductInstallationRepository;
  productUserRepo?: ProductUserRepository;
  productDeviceRefreshTokenRepo?: ProductDeviceRefreshTokenRepository;
  productAuditRepo?: ProductAuditRepository;
  productExchangeCoordinator?: ProductExchangeCoordinator;
  productCredentialRepo?: GoogleCredentialRepository;
  productCredentialCipher?: GoogleCredentialCipher;
  productExchangeFn?: ProductExchangeFn;
  productPublicBaseUrl?: string;
  productPairingRateLimitPerMinute?: number;
  productConnectRateLimitPerMinute?: number;
  productSessionsRateLimitPerMinute?: number;
  // Phase 2I: KMS暗号化・製品用OAuth client分離・setupAdminTokenから独立した署名鍵
  /** setupAdminTokenとは独立した専用master keyから用途別subkeyを導出する。未設定ならavailable=false。 */
  productSigningKeyProvider?: ProductSigningKeyProvider;
  /** devのoauthConfigとは別の製品用Google OAuth client。未設定(null/undefined)ならproduct OAuthは503。 */
  productOAuthConfig?: GoogleOAuthConfig | null;
}

export function createApp(config: AppConfig): Express {
  const app = express();

  const clock = config.clock ?? systemClock;
  const calendarId = config.calendarId ?? DEFAULT_CALENDAR_ID;
  const userId = config.userId ?? DEFAULT_USER_ID;
  const refreshTokenStore = config.refreshTokenStore ?? new InMemoryRefreshTokenStore();
  const verificationTracker = config.verificationTracker ?? createInMemoryOAuthVerificationTracker();
  const pluginSessionRepo = config.pluginSessionRepo ?? new InMemoryPluginSessionRepository();
  const pluginEventCandidateRepo = config.pluginEventCandidateRepo ?? new InMemoryPluginEventCandidateRepository();
  const pluginConversationRepo = config.pluginConversationRepo ?? new InMemoryPluginConversationRepository();
  const pluginRequestDedupeRepo = config.pluginRequestDedupeRepo ?? new InMemoryPluginRequestDedupeRepository();
  const pluginRateLimitRepo = config.pluginRateLimitRepo ?? new InMemoryPluginRateLimitRepository();
  const idempotencyRepo = config.idempotencyRepo ?? new InMemoryIdempotencyRepository();
  const resolveCalendarService = config.resolveCalendarService ?? (async () => null);

  const productPairingRepo = config.productPairingRepo ?? new InMemoryProductPairingRepository();
  const productInstallationRepo = config.productInstallationRepo ?? new InMemoryProductInstallationRepository();
  const productUserRepo = config.productUserRepo ?? new InMemoryProductUserRepository();
  const productDeviceRefreshTokenRepo = config.productDeviceRefreshTokenRepo ?? new InMemoryProductDeviceRefreshTokenRepository();
  const productAuditRepo = config.productAuditRepo ?? new InMemoryProductAuditRepository();
  // exchange(credential activation)はProductPairingRepository等の個別メソッドではなくcoordinatorが
  // 単一transactionでatomicに行う。config側でproductPairingRepo等をカスタム注入する場合、デフォルトの
  // coordinatorはそれらとは別のインメモリstoreを持つため、テスト等でexchangeの整合性を検証したい場合は
  // productExchangeCoordinatorも同じstoreを共有する形で明示的に注入すること。
  const productExchangeCoordinator = config.productExchangeCoordinator ?? new InMemoryProductExchangeCoordinator();
  const productCredentialCipher = config.productCredentialCipher ?? new NotConfiguredGoogleCredentialCipher();
  const productCredentialRepo = config.productCredentialRepo ?? new InMemoryGoogleCredentialRepository(productCredentialCipher);
  const productSigningKeyProvider = config.productSigningKeyProvider ?? new ProductSigningKeyProvider(null);
  const productOAuthConfig = config.productOAuthConfig ?? null;

  app.disable('x-powered-by');
  app.use(helmet());

  app.use(
    express.json({
      limit: JSON_BODY_LIMIT,
      verify: (req: Request, _res, buf) => {
        (req as RequestWithRawBodyLength).rawBodyLength = buf.length;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }));

  app.use(healthRouter);
  app.use(privacyRouter);

  app.use(
    createSetupRouter({
      setupAdminToken: config.setupAdminToken,
      clock,
      refreshTokenStore,
    }),
  );

  app.use(
    createOAuthRouter({
      setupAdminToken: config.setupAdminToken,
      oauthConfig: config.oauthConfig,
      clock,
      refreshTokenStore,
      verificationTracker,
      calendarId,
      ...(config.exchangeAndVerifyFn ? { exchangeAndVerifyFn: config.exchangeAndVerifyFn } : {}),
    }),
  );

  app.use(
    createChatCompletionsRouter(createAuthMiddleware(config.agentToken), {
      ...(config.delayFn ? { delayFn: config.delayFn } : {}),
      enableProbeTests: config.enableProbeTests ?? false,
      clock,
      userId,
      calendarId,
      conversationStateRepo: config.conversationStateRepo ?? new InMemoryConversationStateRepository(),
      idempotencyRepo,
      deliveryDedupeRepo: config.deliveryDedupeRepo ?? new InMemoryDeliveryDedupeRepository(),
      resolveCalendarService,
    }),
  );

  app.use(
    createPluginDevSessionsRouter(createAuthMiddleware(config.setupAdminToken), {
      clock,
      pluginSessionRepo,
    }),
  );

  const geminiClient = config.geminiClient ?? new FakeGeminiClient();
  const geminiModel = config.geminiModel ?? DEFAULT_GEMINI_MODEL;
  const vertexLocation = config.vertexLocation ?? DEFAULT_VERTEX_LOCATION;

  app.use(
    createPluginAnalyzeAudioRouter({
      clock,
      pluginSessionRepo,
      rateLimitRepo: pluginRateLimitRepo,
      requestDedupeRepo: pluginRequestDedupeRepo,
      candidateRepo: pluginEventCandidateRepo,
      conversationRepo: pluginConversationRepo,
      geminiClient,
      geminiModel,
      vertexLocation,
      productInstallationRepo,
      ...(config.geminiTimeoutMs !== undefined ? { geminiTimeoutMs: config.geminiTimeoutMs } : {}),
      ...(config.candidateTtlMs !== undefined ? { candidateTtlMs: config.candidateTtlMs } : {}),
      ...(config.conversationTtlMs !== undefined ? { conversationTtlMs: config.conversationTtlMs } : {}),
    }),
  );

  app.use(
    createPluginAnalyzeFollowupAudioRouter({
      clock,
      pluginSessionRepo,
      conversationRepo: pluginConversationRepo,
      requestDedupeRepo: pluginRequestDedupeRepo,
      candidateRepo: pluginEventCandidateRepo,
      geminiClient,
      geminiModel,
      vertexLocation,
      productInstallationRepo,
      ...(config.geminiTimeoutMs !== undefined ? { geminiTimeoutMs: config.geminiTimeoutMs } : {}),
      ...(config.candidateTtlMs !== undefined ? { candidateTtlMs: config.candidateTtlMs } : {}),
      ...(config.followupLeaseDurationMs !== undefined ? { followupLeaseDurationMs: config.followupLeaseDurationMs } : {}),
    }),
  );

  app.use(
    createPluginAnalyzeEditAudioRouter({
      clock,
      pluginSessionRepo,
      rateLimitRepo: pluginRateLimitRepo,
      requestDedupeRepo: pluginRequestDedupeRepo,
      calendarId,
      resolveCalendarService,
      geminiClient,
      geminiModel,
      vertexLocation,
      productInstallationRepo,
      ...(config.geminiTimeoutMs !== undefined ? { geminiTimeoutMs: config.geminiTimeoutMs } : {}),
      ...(config.analyzeEditAudioRateLimitPerMinute !== undefined ? { rateLimitPerMinute: config.analyzeEditAudioRateLimitPerMinute } : {}),
      ...(config.analyzeEditAudioCalendarTimeoutMs !== undefined ? { calendarTimeoutMs: config.analyzeEditAudioCalendarTimeoutMs } : {}),
    }),
  );

  app.use(
    createPluginConversationsCancelRouter({
      clock,
      pluginSessionRepo,
      conversationRepo: pluginConversationRepo,
      productInstallationRepo,
    }),
  );

  app.use(
    createPluginCalendarEventsRouter({
      clock,
      pluginSessionRepo,
      candidateRepo: pluginEventCandidateRepo,
      resolveCalendarService,
      productInstallationRepo,
    }),
  );

  app.use(
    createPluginCalendarEventsDayRouter({
      clock,
      pluginSessionRepo,
      rateLimitRepo: pluginRateLimitRepo,
      calendarId,
      resolveCalendarService,
      productInstallationRepo,
      ...(config.calendarEventsDayRateLimitPerMinute !== undefined
        ? { rateLimitPerMinute: config.calendarEventsDayRateLimitPerMinute }
        : {}),
      ...(config.calendarEventsDayTimeoutMs !== undefined ? { calendarTimeoutMs: config.calendarEventsDayTimeoutMs } : {}),
    }),
  );

  app.use(
    createPluginCalendarEventsUpcomingRouter({
      clock,
      pluginSessionRepo,
      rateLimitRepo: pluginRateLimitRepo,
      calendarId,
      resolveCalendarService,
      productInstallationRepo,
      ...(config.calendarEventsUpcomingRateLimitPerMinute !== undefined
        ? { rateLimitPerMinute: config.calendarEventsUpcomingRateLimitPerMinute }
        : {}),
      ...(config.calendarEventsUpcomingTimeoutMs !== undefined
        ? { calendarTimeoutMs: config.calendarEventsUpcomingTimeoutMs }
        : {}),
    }),
  );

  // 注意: /plugin/calendar-events/:eventId は day/upcoming/status等の具体パスとぶつかりうる
  // ワイルドカードルートのため、必ずそれらのrouter登録より後にmountすること(Expressは登録順に
  // 一致を試すため、先に登録した具体パスのrouterが優先される)。
  app.use(
    createPluginCalendarEventsItemRouter({
      clock,
      pluginSessionRepo,
      rateLimitRepo: pluginRateLimitRepo,
      idempotencyRepo,
      calendarId,
      resolveCalendarService,
      productInstallationRepo,
      ...(config.calendarEventsItemRateLimitPerMinute !== undefined
        ? { rateLimitPerMinute: config.calendarEventsItemRateLimitPerMinute }
        : {}),
      ...(config.calendarEventsItemTimeoutMs !== undefined ? { calendarTimeoutMs: config.calendarEventsItemTimeoutMs } : {}),
    }),
  );

  app.use(
    createProductPairingsRouter({
      clock,
      rateLimitRepo: pluginRateLimitRepo,
      pairingRepo: productPairingRepo,
      installationRepo: productInstallationRepo,
      auditRepo: productAuditRepo,
      exchangeCoordinator: productExchangeCoordinator,
      ...(config.productPublicBaseUrl !== undefined ? { publicBaseUrl: config.productPublicBaseUrl } : {}),
      ...(config.productPairingRateLimitPerMinute !== undefined
        ? { rateLimitPerMinute: config.productPairingRateLimitPerMinute }
        : {}),
    }),
  );

  app.use(
    createProductConnectPageRouter({
      clock,
      rateLimitRepo: pluginRateLimitRepo,
      pairingRepo: productPairingRepo,
      signingKeyProvider: productSigningKeyProvider,
      ...(config.productConnectRateLimitPerMinute !== undefined
        ? { rateLimitPerMinute: config.productConnectRateLimitPerMinute }
        : {}),
    }),
  );

  app.use(
    createProductOAuthRouter({
      clock,
      productOAuthConfig,
      signingKeyProvider: productSigningKeyProvider,
      pairingRepo: productPairingRepo,
      userRepo: productUserRepo,
      credentialRepo: productCredentialRepo,
      ...(config.productExchangeFn ? { exchangeFn: config.productExchangeFn } : {}),
    }),
  );

  app.use(
    createProductSessionsRouter({
      clock,
      pluginSessionRepo,
      rateLimitRepo: pluginRateLimitRepo,
      deviceRefreshTokenRepo: productDeviceRefreshTokenRepo,
      installationRepo: productInstallationRepo,
      auditRepo: productAuditRepo,
      ...(config.productSessionsRateLimitPerMinute !== undefined
        ? { rateLimitPerMinute: config.productSessionsRateLimitPerMinute }
        : {}),
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
