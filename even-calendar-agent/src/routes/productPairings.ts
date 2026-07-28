import { randomUUID, createHash } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Clock } from '../time/clock.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { hashValue, shortHashPrefix } from '../security/devSessionToken.js';
import { generateDevSessionToken } from '../security/devSessionToken.js';
import { generateUserCode, normalizeUserCodeInput } from '../product/userCode.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';
import type { PluginRateLimitRepository } from '../firestore/pluginRateLimitRepository.js';
import type { ProductPairingRepository } from '../product/productPairingRepository.js';
import type { ProductInstallationRepository } from '../product/productInstallationRepository.js';
import type { ProductAuditRepository } from '../product/productAuditRepository.js';
import type { ProductDeviceRefreshTokenRepository } from '../product/productDeviceRefreshTokenRepository.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 3;
const DEVICE_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEVICE_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_SCOPES = ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read', 'calendar:update', 'calendar:delete'];
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
const MAX_APP_VERSION_LENGTH = 40;

export interface ProductPairingsRouterDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
  rateLimitRepo: PluginRateLimitRepository;
  pairingRepo: ProductPairingRepository;
  installationRepo: ProductInstallationRepository;
  auditRepo: ProductAuditRepository;
  deviceRefreshTokenRepo: ProductDeviceRefreshTokenRepository;
  publicBaseUrl?: string;
  rateLimitPerMinute?: number;
}

function corsHeaders(methods: string): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Installation-Id, X-Request-Id');
    next();
  };
}

function errorJson(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error' } });
}

function resolveBaseUrl(req: Request, deps: ProductPairingsRouterDeps): string {
  if (deps.publicBaseUrl) return deps.publicBaseUrl;
  return `https://${req.get('host')}`;
}

function requestIdHash(req: Request): string | null {
  const requestId = req.header('x-request-id');
  return requestId ? shortHashPrefix(hashValue(requestId)) : null;
}

export function createProductPairingsRouter(deps: ProductPairingsRouterDeps): Router {
  const router = Router();
  const rateLimitPerMinute = deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;

  async function checkRateLimit(res: Response, bucketPrefix: string, key: string): Promise<boolean> {
    const now = deps.clock.now();
    const result = await deps.rateLimitRepo.consume({
      sessionKey: `${bucketPrefix}:${key}`,
      now,
      limit: rateLimitPerMinute,
    });
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
    }
    return result.allowed;
  }

  router.options('/product/pairings', corsHeaders('POST, OPTIONS'), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.post('/product/pairings', corsHeaders('POST, OPTIONS'), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const body = req.body as { installationId?: unknown; appVersion?: unknown; sdkVersion?: unknown } | undefined;
    const installationId = typeof body?.installationId === 'string' ? body.installationId : '';
    if (!UUID_PATTERN.test(installationId)) {
      errorJson(res, 400, 'installationId must be a valid UUID');
      return;
    }
    const appVersion = typeof body?.appVersion === 'string' ? body.appVersion.slice(0, MAX_APP_VERSION_LENGTH) : null;
    const sdkVersion = typeof body?.sdkVersion === 'string' ? body.sdkVersion.slice(0, MAX_APP_VERSION_LENGTH) : null;

    const installationIdHash = hashValue(installationId);
    const ipHash = hashValue(req.ip ?? 'unknown');

    const ipAllowed = await checkRateLimit(res, 'pairing-create-ip', ipHash);
    const installationAllowed = ipAllowed ? await checkRateLimit(res, 'pairing-create-install', installationIdHash) : true;
    if (!ipAllowed || !installationAllowed) {
      errorJson(res, 429, 'Too Many Requests');
      return;
    }

    const now = deps.clock.now();
    await deps.installationRepo.getOrCreate({ installationId, now, appVersion, sdkVersion });
    await deps.pairingRepo.cancelActiveForInstallation(installationIdHash, now);

    const pairingId = randomUUID();
    const userCode = generateUserCode();
    // 保存するhashは/connect/verify側と同じ正規化(ハイフン除去・大文字化)を通した値にすること。
    // ここで正規化前の生表示形式(ハイフン付き)をhashすると、verify側のnormalizeUserCodeInput後の
    // hashと恒久的に一致しなくなる。
    const userCodeHash = hashValue(normalizeUserCodeInput(userCode));
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);

    await deps.pairingRepo.create({ pairingId, userCodeHash, installationIdHash, now, expiresAt });
    await deps.auditRepo.record({
      userIdHash: null,
      installationIdHash: shortHashPrefix(installationIdHash),
      requestIdHash: requestIdHash(req),
      action: 'pairing_started',
      result: 'ok',
      sanitizedErrorCode: null,
      now,
    });
    logSafeEvent({ event: 'product_pairing_started', installIdHashPrefix: shortHashPrefix(installationIdHash) });

    res.status(201).json({
      pairingId,
      userCode,
      verificationUrl: `${resolveBaseUrl(req, deps)}/connect`,
      expiresInSeconds: PAIRING_TTL_MS / 1000,
      pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    });
  });

  router.options('/product/pairings/:pairingId/status', corsHeaders('GET, OPTIONS'), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.get('/product/pairings/:pairingId/status', corsHeaders('GET, OPTIONS'), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const pairingId = req.params.pairingId ?? '';
    const installationId = req.header('x-installation-id') ?? '';
    if (!UUID_PATTERN.test(pairingId) || !UUID_PATTERN.test(installationId)) {
      errorJson(res, 400, 'Invalid request');
      return;
    }

    const allowed = await checkRateLimit(res, 'pairing-status', `${pairingId}:${hashValue(installationId)}`);
    if (!allowed) {
      errorJson(res, 429, 'Too Many Requests');
      return;
    }

    const now = deps.clock.now();
    const doc = await deps.pairingRepo.getById(pairingId);
    const installationIdHash = hashValue(installationId);

    if (!doc || doc.installationIdHash !== installationIdHash) {
      res.status(200).json({ status: 'expired' });
      return;
    }

    await deps.pairingRepo.recordPollAttempt(pairingId, now);

    const effectiveStatus =
      (doc.status === 'pending' || doc.status === 'oauth_in_progress') && doc.expiresAt.getTime() <= now.getTime()
        ? 'expired'
        : doc.status;

    res.status(200).json({ status: effectiveStatus });
  });

  router.options('/product/pairings/:pairingId/cancel', corsHeaders('POST, OPTIONS'), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.post('/product/pairings/:pairingId/cancel', corsHeaders('POST, OPTIONS'), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const pairingId = req.params.pairingId ?? '';
    const body = req.body as { installationId?: unknown } | undefined;
    const installationId = typeof body?.installationId === 'string' ? body.installationId : '';
    if (!UUID_PATTERN.test(pairingId) || !UUID_PATTERN.test(installationId)) {
      errorJson(res, 400, 'Invalid request');
      return;
    }

    const now = deps.clock.now();
    const doc = await deps.pairingRepo.getById(pairingId);
    if (doc && doc.installationIdHash === hashValue(installationId) && doc.status !== 'exchanged') {
      await deps.pairingRepo.markCancelled(pairingId, now);
    }
    // best-effort/idempotent: 存在しない・既にexchanged・installation不一致でも常に200
    res.status(200).json({ cancelled: true });
  });

  router.options('/product/pairings/:pairingId/exchange', corsHeaders('POST, OPTIONS'), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.post('/product/pairings/:pairingId/exchange', corsHeaders('POST, OPTIONS'), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const pairingId = req.params.pairingId ?? '';
    const body = req.body as { installationId?: unknown } | undefined;
    const installationId = typeof body?.installationId === 'string' ? body.installationId : '';
    if (!UUID_PATTERN.test(pairingId) || !UUID_PATTERN.test(installationId)) {
      errorJson(res, 400, 'Invalid request');
      return;
    }

    const now = deps.clock.now();
    const installationIdHash = hashValue(installationId);
    const result = await deps.pairingRepo.markExchangedIfApproved(pairingId, installationIdHash, now);

    if (result.kind !== 'exchanged') {
      const status = result.kind === 'not_found' || result.kind === 'installation_mismatch' ? 400 : 409;
      await deps.auditRepo.record({
        userIdHash: null,
        installationIdHash: shortHashPrefix(installationIdHash),
        requestIdHash: requestIdHash(req),
        action: 'device_session_issued',
        result: 'rejected',
        sanitizedErrorCode: result.kind,
        now,
      });
      errorJson(res, status, 'Pairing is not ready to be exchanged');
      return;
    }

    const userId = result.doc.userId;
    if (!userId) {
      errorJson(res, 409, 'Pairing is not ready to be exchanged');
      return;
    }

    const installation = await deps.installationRepo.getOrCreate({ installationId, now, appVersion: null, sdkVersion: null });
    await deps.installationRepo.bindUser(installationId, userId, now);

    const accessToken = generateDevSessionToken();
    const accessTokenHash = createHash('sha256').update(accessToken, 'utf8').digest('hex');
    await deps.pluginSessionRepo.create({
      tokenHash: accessTokenHash,
      installId: installationId,
      scope: DEVICE_SCOPES,
      now,
      expiresAt: new Date(now.getTime() + DEVICE_ACCESS_TOKEN_TTL_MS),
      tokenType: 'device',
      userId,
      tokenVersion: installation.tokenVersion,
    });

    const refreshToken = generateDevSessionToken();
    const refreshTokenHash = createHash('sha256').update(refreshToken, 'utf8').digest('hex');
    const familyId = randomUUID();
    const refreshTokenExpiresAt = new Date(now.getTime() + DEVICE_REFRESH_TOKEN_TTL_MS);
    await deps.deviceRefreshTokenRepo.create({
      refreshTokenHash,
      installationId,
      userId,
      familyId,
      generation: 1,
      now,
      expiresAt: refreshTokenExpiresAt,
    });

    await deps.auditRepo.record({
      userIdHash: shortHashPrefix(hashValue(userId)),
      installationIdHash: shortHashPrefix(installationIdHash),
      requestIdHash: requestIdHash(req),
      action: 'device_session_issued',
      result: 'ok',
      sanitizedErrorCode: null,
      now,
    });
    logSafeEvent({ event: 'product_device_session_issued', installIdHashPrefix: shortHashPrefix(installationIdHash) });

    res.status(200).json({
      accessToken,
      accessTokenExpiresInSeconds: DEVICE_ACCESS_TOKEN_TTL_MS / 1000,
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      scopes: DEVICE_SCOPES,
    });
  });

  return router;
}
