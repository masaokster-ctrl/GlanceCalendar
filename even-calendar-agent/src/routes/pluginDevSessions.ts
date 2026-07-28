import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Clock } from '../time/clock.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { generateDevSessionToken, hashDevSessionToken, shortHashPrefix } from '../security/devSessionToken.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';

const VALID_SCOPES = ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read', 'calendar:update', 'calendar:delete'] as const;
const MAX_EXPIRES_IN_SECONDS = 86_400; // 24時間
const DEFAULT_EXPIRES_IN_SECONDS = 86_400;
const INSTALL_ID_MAX_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface PluginDevSessionsRouterDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
}

interface CreateSessionBody {
  installId?: unknown;
  scope?: unknown;
  expiresInSeconds?: unknown;
}

interface RevokeSessionBody {
  tokenHash?: unknown;
}

function invalidRequest(res: Response, message: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error' } });
}

/** 定義済みスコープ({@link VALID_SCOPES})の非空・重複なし部分集合であることを検証する。 */
function isValidScopeArray(scope: unknown): scope is string[] {
  if (!Array.isArray(scope) || scope.length === 0) return false;
  if (!scope.every((s): s is string => typeof s === 'string' && (VALID_SCOPES as readonly string[]).includes(s))) {
    return false;
  }
  return new Set(scope).size === scope.length;
}

export function createPluginDevSessionsRouter(authMiddleware: RequestHandler, deps: PluginDevSessionsRouterDeps): Router {
  const router = Router();

  router.post('/plugin/dev-sessions', authMiddleware, async (req: Request, res: Response) => {
    const body = req.body as CreateSessionBody | undefined;

    const installId = typeof body?.installId === 'string' ? body.installId : '';
    if (!installId || installId.length > INSTALL_ID_MAX_LENGTH || !UUID_PATTERN.test(installId)) {
      invalidRequest(res, 'installId must be a valid UUID');
      return;
    }

    const requestedScope = body?.scope;
    if (!isValidScopeArray(requestedScope)) {
      invalidRequest(res, `scope must be a non-empty, duplicate-free subset of ${JSON.stringify(VALID_SCOPES)}`);
      return;
    }
    const scope = requestedScope;

    let expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS;
    if (body?.expiresInSeconds !== undefined) {
      const raw = body.expiresInSeconds;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || raw > MAX_EXPIRES_IN_SECONDS) {
        invalidRequest(res, 'expiresInSeconds must be an integer between 1 and 86400');
        return;
      }
      expiresInSeconds = raw;
    }

    const now = deps.clock.now();
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000);

    const token = generateDevSessionToken();
    const tokenHash = hashDevSessionToken(token);

    await deps.pluginSessionRepo.create({
      tokenHash,
      installId,
      scope,
      now,
      expiresAt,
    });

    logSafeEvent({
      event: 'plugin_dev_session_created',
      sessionHashPrefix: shortHashPrefix(tokenHash),
      expiresInSeconds,
      scope,
    });

    res.status(201).json({
      token,
      tokenHash,
      installId,
      scope,
      expiresAt: expiresAt.toISOString(),
    });
  });

  router.post('/plugin/dev-sessions/revoke', authMiddleware, async (req: Request, res: Response) => {
    const body = req.body as RevokeSessionBody | undefined;
    const tokenHash = typeof body?.tokenHash === 'string' ? body.tokenHash : '';

    if (!TOKEN_HASH_PATTERN.test(tokenHash)) {
      invalidRequest(res, 'tokenHash must be a 64-character hex SHA-256 hash');
      return;
    }

    const now = deps.clock.now();
    const result = await deps.pluginSessionRepo.revoke(tokenHash, now);

    logSafeEvent({
      event: 'plugin_dev_session_revoked',
      sessionHashPrefix: shortHashPrefix(tokenHash),
    });

    if (!result.found) {
      res.status(404).json({ error: { message: 'Not Found', type: 'invalid_request_error' } });
      return;
    }

    res.status(200).json({ revoked: true });
  });

  return router;
}
