import { createHash } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Clock } from '../time/clock.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { generateDevSessionToken, hashValue, shortHashPrefix } from '../security/devSessionToken.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';
import type { PluginRateLimitRepository } from '../firestore/pluginRateLimitRepository.js';
import type { ProductDeviceRefreshTokenRepository } from '../product/productDeviceRefreshTokenRepository.js';
import type { ProductInstallationRepository } from '../product/productInstallationRepository.js';
import type { ProductAuditRepository } from '../product/productAuditRepository.js';
import { resolvePrincipal } from '../product/principal.js';

const DEVICE_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEVICE_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProductSessionsRouterDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
  rateLimitRepo: PluginRateLimitRepository;
  deviceRefreshTokenRepo: ProductDeviceRefreshTokenRepository;
  installationRepo: ProductInstallationRepository;
  auditRepo: ProductAuditRepository;
  rateLimitPerMinute?: number;
}

function corsHeaders(methods: string): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Install-Id, X-Installation-Id, X-Request-Id');
    next();
  };
}

function errorJson(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error' } });
}

export function createProductSessionsRouter(deps: ProductSessionsRouterDeps): Router {
  const router = Router();
  const rateLimitPerMinute = deps.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;

  router.options('/product/sessions/refresh', corsHeaders('POST, OPTIONS'), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.post('/product/sessions/refresh', corsHeaders('POST, OPTIONS'), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const installationId = req.header('x-installation-id') ?? '';
    const body = req.body as { refreshToken?: unknown } | undefined;
    const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
    if (!UUID_PATTERN.test(installationId) || refreshToken.length === 0) {
      errorJson(res, 400, 'Invalid request');
      return;
    }

    const now = deps.clock.now();
    const rateLimitResult = await deps.rateLimitRepo.consume({
      sessionKey: `product-refresh:${hashValue(installationId)}`,
      now,
      limit: rateLimitPerMinute,
    });
    if (!rateLimitResult.allowed) {
      res.setHeader('Retry-After', String(rateLimitResult.retryAfterSeconds));
      errorJson(res, 429, 'Too Many Requests');
      return;
    }

    const oldHash = createHash('sha256').update(refreshToken, 'utf8').digest('hex');
    const existing = await deps.deviceRefreshTokenRepo.getByHash(oldHash);
    if (!existing || existing.installationId !== installationId) {
      errorJson(res, 401, 'Invalid refresh token');
      return;
    }

    const newRefreshToken = generateDevSessionToken();
    const newHash = createHash('sha256').update(newRefreshToken, 'utf8').digest('hex');
    const refreshTokenExpiresAt = new Date(now.getTime() + DEVICE_REFRESH_TOKEN_TTL_MS);

    const result = await deps.deviceRefreshTokenRepo.rotate(oldHash, {
      refreshTokenHash: newHash,
      installationId: existing.installationId,
      userId: existing.userId,
      familyId: existing.familyId,
      generation: existing.generation + 1,
      now,
      expiresAt: refreshTokenExpiresAt,
    });

    if (result.kind === 'reuse_detected') {
      await deps.deviceRefreshTokenRepo.revokeFamily(result.familyId, now);
      await deps.installationRepo.revoke(installationId, now);
      await deps.auditRepo.record({
        userIdHash: shortHashPrefix(hashValue(existing.userId)),
        installationIdHash: shortHashPrefix(hashValue(installationId)),
        requestIdHash: null,
        action: 'reuse_detected',
        result: 'family_revoked',
        sanitizedErrorCode: 'refresh_token_reuse',
        now,
      });
      logSafeEvent({ event: 'product_refresh_reuse_detected', installIdHashPrefix: shortHashPrefix(hashValue(installationId)) });
      errorJson(res, 401, 'Invalid refresh token');
      return;
    }

    if (result.kind !== 'rotated') {
      errorJson(res, 401, 'Invalid refresh token');
      return;
    }

    const installation = await deps.installationRepo.get(installationId);
    if (!installation || installation.status === 'revoked') {
      errorJson(res, 401, 'Invalid refresh token');
      return;
    }

    const newAccessToken = generateDevSessionToken();
    const newAccessTokenHash = createHash('sha256').update(newAccessToken, 'utf8').digest('hex');
    await deps.pluginSessionRepo.create({
      tokenHash: newAccessTokenHash,
      installId: installationId,
      scope: ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read', 'calendar:update', 'calendar:delete'],
      now,
      expiresAt: new Date(now.getTime() + DEVICE_ACCESS_TOKEN_TTL_MS),
      tokenType: 'device',
      userId: existing.userId,
      tokenVersion: installation.tokenVersion,
    });

    await deps.installationRepo.touchLastSeen(installationId, now);
    logSafeEvent({ event: 'product_device_session_refreshed', installIdHashPrefix: shortHashPrefix(hashValue(installationId)) });

    res.status(200).json({
      accessToken: newAccessToken,
      accessTokenExpiresInSeconds: DEVICE_ACCESS_TOKEN_TTL_MS / 1000,
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      scopes: ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read', 'calendar:update', 'calendar:delete'],
    });
  });

  router.get('/product/session', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const auth = await resolvePrincipal(
      req,
      { clock: deps.clock, pluginSessionRepo: deps.pluginSessionRepo, productInstallationRepo: deps.installationRepo },
      'calendar:status',
    );
    if (!auth.ok) {
      errorJson(res, auth.status, 'Unauthorized');
      return;
    }

    res.status(200).json({
      tokenType: auth.principal.tokenType,
      installationId: auth.principal.tokenType === 'device' ? auth.principal.installId : null,
      connected: auth.principal.tokenType === 'device' ? auth.principal.userId !== null : true,
    });
  });

  router.post('/product/installations/revoke', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const auth = await resolvePrincipal(
      req,
      { clock: deps.clock, pluginSessionRepo: deps.pluginSessionRepo, productInstallationRepo: deps.installationRepo },
      'calendar:status',
    );
    if (!auth.ok) {
      errorJson(res, auth.status, 'Unauthorized');
      return;
    }
    if (auth.principal.tokenType !== 'device') {
      errorJson(res, 403, 'Forbidden');
      return;
    }

    const now = deps.clock.now();
    const body = req.body as { refreshToken?: unknown } | undefined;
    const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : null;
    if (refreshToken) {
      const hash = createHash('sha256').update(refreshToken, 'utf8').digest('hex');
      const doc = await deps.deviceRefreshTokenRepo.getByHash(hash);
      if (doc && doc.installationId === auth.principal.installId) {
        await deps.deviceRefreshTokenRepo.revokeFamily(doc.familyId, now);
      }
    }

    await deps.installationRepo.revoke(auth.principal.installId, now);
    await deps.auditRepo.record({
      userIdHash: auth.principal.userId ? shortHashPrefix(hashValue(auth.principal.userId)) : null,
      installationIdHash: shortHashPrefix(hashValue(auth.principal.installId)),
      requestIdHash: null,
      action: 'installation_revoked',
      result: 'ok',
      sanitizedErrorCode: null,
      now,
    });
    logSafeEvent({ event: 'product_installation_revoked', installIdHashPrefix: shortHashPrefix(hashValue(auth.principal.installId)) });

    res.status(200).json({ revoked: true });
  });

  return router;
}
