import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { safeCompare } from '../security/timingSafe.js';

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/**
 * Authorization: Bearer <token> が環境変数 EVEN_AGENT_TOKEN と一致するか検証する。
 * 一致しない場合は 401 を返す。
 */
export function createAuthMiddleware(expectedToken: string): RequestHandler {
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.header('authorization');
    const match = typeof authHeader === 'string' ? BEARER_PATTERN.exec(authHeader) : null;
    const providedToken = match?.[1];

    if (!providedToken || !safeCompare(providedToken, expectedToken)) {
      res.status(401).json({
        error: {
          message: 'Unauthorized',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    next();
  };
}
