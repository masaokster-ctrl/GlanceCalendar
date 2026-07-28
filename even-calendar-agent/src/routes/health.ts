import { Router } from 'express';

export const healthRouter = Router();

// GET /health だけに限定したCORS許可。他のルート(/v1/chat/completions、/oauth2/*、/setup/*)には
// 一切適用しない。/health は認証不要・非機密のエンドポイントであるため、Even Hub WebView等の
// 別オリジンからの疎通確認を許可しても新たなリスクを生まない。
healthRouter.use('/health', (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  next();
});

healthRouter.options('/health', (_req, res) => {
  res.status(204).end();
});

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
