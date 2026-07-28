import type { Request } from 'express';
import type { Clock } from '../time/clock.js';
import { hashDevSessionToken } from '../security/devSessionToken.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';
import type { ProductInstallationRepository } from './productInstallationRepository.js';

/**
 * dev session(既存のPowerShell発行トークン)とdevice session(Phase 2H製品用access token)を
 * 同一のFirestore collection(pluginSessions)・同一のhash/期限/失効ロジックで扱うための共通principal。
 * tokenType未設定の既存ドキュメントは'dev'として扱う(後方互換)。
 */
export interface AuthPrincipal {
  tokenType: 'dev' | 'device';
  tokenHash: string;
  installId: string;
  userId: string | null;
  scope: string[];
}

export interface ResolvePrincipalResult_Ok {
  ok: true;
  principal: AuthPrincipal;
}
export interface ResolvePrincipalResult_Fail {
  ok: false;
  status: number;
}
export type ResolvePrincipalResult = ResolvePrincipalResult_Ok | ResolvePrincipalResult_Fail;

export interface ResolvePrincipalDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
  /** device sessionのtokenVersion突合・installation失効確認に使う。dev専用routeでは省略可。 */
  productInstallationRepo?: ProductInstallationRepository;
}

/**
 * Authorization: Bearer <token> と X-Install-Id を検証し、共通principalへ解決する。
 * dev/device双方とも401(認証不可)/403(scope不足・installId不一致・installation失効)を統一的に返す。
 * リクエストbodyのuserId等は一切信用せず、必ずこのprincipal由来のuserId/installationIdのみを使うこと。
 */
export async function resolvePrincipal(
  req: Request,
  deps: ResolvePrincipalDeps,
  requiredScope: string,
): Promise<ResolvePrincipalResult> {
  const authHeader = req.header('authorization');
  const bearerMatch = typeof authHeader === 'string' ? /^Bearer\s+(.+)$/i.exec(authHeader) : null;
  const providedToken = bearerMatch?.[1];
  if (!providedToken) {
    return { ok: false, status: 401 };
  }

  const installIdHeader = req.header('x-install-id');
  if (!installIdHeader) {
    return { ok: false, status: 400 };
  }

  const now = deps.clock.now();
  const tokenHash = hashDevSessionToken(providedToken);
  const session = await deps.pluginSessionRepo.get(tokenHash);

  if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, status: 401 };
  }
  if (!session.scope.includes(requiredScope) || session.installId !== installIdHeader) {
    return { ok: false, status: 403 };
  }

  const tokenType: 'dev' | 'device' = session.tokenType === 'device' ? 'device' : 'dev';

  if (tokenType === 'device') {
    if (!deps.productInstallationRepo) {
      return { ok: false, status: 403 };
    }
    const installation = await deps.productInstallationRepo.get(session.installId);
    if (!installation || installation.status === 'revoked') {
      return { ok: false, status: 403 };
    }
    if (session.tokenVersion !== undefined && session.tokenVersion !== installation.tokenVersion) {
      return { ok: false, status: 403 };
    }
    if (!installation.userId || session.userId !== installation.userId) {
      return { ok: false, status: 403 };
    }
  }

  return {
    ok: true,
    principal: {
      tokenType,
      tokenHash,
      installId: session.installId,
      userId: session.userId ?? null,
      scope: session.scope,
    },
  };
}
