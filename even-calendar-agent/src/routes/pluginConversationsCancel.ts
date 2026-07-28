import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Clock } from '../time/clock.js';
import { logSafeEvent } from '../security/safeLogger.js';
import { hashValue, shortHashPrefix } from '../security/devSessionToken.js';
import type { PluginSessionRepository } from '../firestore/pluginSessionRepository.js';
import type { PluginConversationRepository } from '../firestore/pluginConversationRepository.js';
import { resolvePrincipal } from '../product/principal.js';
import type { ProductInstallationRepository } from '../product/productInstallationRepository.js';

const REQUIRED_SCOPE = 'audio:analyze';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PluginConversationsCancelRouterDeps {
  clock: Clock;
  pluginSessionRepo: PluginSessionRepository;
  conversationRepo: PluginConversationRepository;
  /** device session(Phase 2H)のtokenVersion/installation失効確認に使う。dev専用利用時は省略可。 */
  productInstallationRepo?: ProductInstallationRepository;
}

interface CancelBody {
  conversationId?: unknown;
}

function corsHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Install-Id, X-Request-Id');
    next();
  };
}

function errorJson(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error' } });
}

export function createPluginConversationsCancelRouter(deps: PluginConversationsCancelRouterDeps): Router {
  const router = Router();

  router.options('/plugin/conversations/cancel', corsHeaders(), (_req: Request, res: Response) => {
    res.status(204).end();
  });

  router.post('/plugin/conversations/cancel', corsHeaders(), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const auth = await resolvePrincipal(
      req,
      {
        clock: deps.clock,
        pluginSessionRepo: deps.pluginSessionRepo,
        ...(deps.productInstallationRepo ? { productInstallationRepo: deps.productInstallationRepo } : {}),
      },
      REQUIRED_SCOPE,
    );
    if (!auth.ok) {
      errorJson(res, auth.status, auth.status === 401 ? 'Unauthorized' : auth.status === 403 ? 'Forbidden' : 'Bad Request');
      return;
    }
    const tokenHash = auth.principal.tokenHash;
    const installId = auth.principal.installId;
    const now = deps.clock.now();

    const body = req.body as CancelBody | undefined;
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    if (!UUID_PATTERN.test(conversationId)) {
      errorJson(res, 400, 'conversationId must be a valid UUID');
      return;
    }

    const conversation = await deps.conversationRepo.get(conversationId);

    logSafeEvent({
      event: 'plugin_conversation_cancel_requested',
      command: 'conversation_cancel',
      candidateHashPrefix: shortHashPrefix(hashValue(conversationId)),
    });

    // 存在しない/他セッションのconversationIdでも、情報を漏らさずidempotentに200を返す。
    if (!conversation || conversation.sessionHash !== tokenHash || conversation.installIdHash !== hashValue(installId)) {
      res.status(200).json({ conversationId, status: 'cancelled' });
      return;
    }

    if (conversation.status === 'awaiting_clarification' || conversation.status === 'analyzing_followup') {
      await deps.conversationRepo.markCancelled(conversationId, now);
    }

    res.status(200).json({ conversationId, status: 'cancelled' });
  });

  return router;
}
