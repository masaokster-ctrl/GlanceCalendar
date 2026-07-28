import { Router } from 'express';

export const privacyRouter = Router();

const PRIVACY_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>プライバシーポリシー - even-calendar-agent</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 640px;
    margin: 2rem auto;
    padding: 0 1rem;
    line-height: 1.7;
    color: #1a1a1a;
  }
  h1 { font-size: 1.4rem; }
  ul { padding-left: 1.2rem; }
</style>
</head>
<body>
<h1>プライバシーポリシー</h1>
<p>
  本サーバー（even-calendar-agent）は、Even AI Agent Configuration との接続仕様を
  確認するための調査用サーバーです。継続的なサービス提供を目的としたものではありません。
</p>
<ul>
  <li>会話の本文（リクエストおよびレスポンスの内容）は永続的に保存しません。</li>
  <li>
    調査目的で、リクエストの構造に関するメタデータ（HTTPメソッド、パス、
    JSONフィールド名や型など）のみを一時的なログとして出力する場合があります。
  </li>
  <li>APIトークンおよび Authorization ヘッダーの値はログに記録しません。</li>
  <li>本サーバーは開発・検証段階のものであり、可用性やデータ保護を保証するものではありません。</li>
</ul>
<p>本ページおよび本サービスに関するお問い合わせは開発者までご連絡ください。</p>
</body>
</html>
`;

privacyRouter.get('/privacy', (_req, res) => {
  res.status(200).type('html').send(PRIVACY_HTML);
});
