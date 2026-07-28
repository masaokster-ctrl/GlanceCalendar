import type { NextFunction, Request, Response } from 'express';
import { buildSafeRequestMetadata } from '../utils/safeRequestMetadata.js';

export type RequestWithRawBodyLength = Request & { rawBodyLength?: number };

/**
 * 調査用の構造化ログを1件出力する。会話本文・トークン・Authorizationヘッダーの値は含めない。
 */
export function requestMetadataLogger(req: Request, _res: Response, next: NextFunction): void {
  const bodyByteLength = (req as RequestWithRawBodyLength).rawBodyLength ?? 0;
  const metadata = buildSafeRequestMetadata(req, bodyByteLength);

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'chat_completions_request_received',
      ...metadata,
    }),
  );

  next();
}
