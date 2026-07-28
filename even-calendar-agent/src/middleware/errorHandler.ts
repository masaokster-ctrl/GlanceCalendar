import type { NextFunction, Request, Response } from 'express';

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  413: 'Payload Too Large',
};

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      message: 'Not Found',
      type: 'invalid_request_error',
    },
  });
}

interface ErrorWithStatus {
  status?: unknown;
  statusCode?: unknown;
}

function resolveStatus(err: unknown): number {
  const candidate = err as ErrorWithStatus;
  const status = typeof candidate?.status === 'number' ? candidate.status : candidate?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

/**
 * グローバルエラーハンドラー。内部のエラー詳細やスタックトレースは応答に含めない。
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'unhandled_error',
      method: req.method,
      path: req.path,
      timestamp: new Date().toISOString(),
    }),
  );

  if (res.headersSent) {
    return;
  }

  const status = resolveStatus(err);
  const message = STATUS_MESSAGES[status] ?? (status < 500 ? 'Bad Request' : 'Internal Server Error');

  res.status(status).json({
    error: {
      message,
      type: 'invalid_request_error',
    },
  });
}
