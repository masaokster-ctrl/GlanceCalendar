# even-calendar-agent

Even G2 の **Even AI Agent Configuration** から接続する、OpenAI Chat Completions API 互換のサーバーです。
フェーズ0/0.5でEven AIとの接続仕様を確認し、フェーズ1Aで **Google Calendar 連携の基盤**（OAuth・Firestoreによる
会話状態管理・冪等性制御）を実装しました。Geminiによる自由文解析は**まだ実装していません**（フェーズ1B以降の予定）。

## 目的（フェーズ1A時点）

- Even G2から「今日の予定」「明日の予定」をGoogle Calendarから取得して読み上げられるようにする
- 固定文言のテスト予定（「接続テスト予定」）を、確認 → 登録の2ステップでGoogle Calendarへ安全に登録できるようにする
- Google OAuth・Firestoreによる会話状態管理・冪等性制御を、実際のCalendar書き込みを伴う形で安全に検証する
- Even AIの実機調査で判明した「同一内容のリクエストが数ミリ秒差で複数届く場合がある」という挙動を前提に、
  Google Calendarへの書き込みを**at-least-once配送前提**で冪等に設計する

## 対応する発話（フェーズ1A）

| 発話例 | 動作 |
| --- | --- |
| 「今日の予定を教えて」「今日のスケジュールを教えて」 | 今日(Asia/Tokyo基準)のprimaryカレンダーの予定を読み上げる |
| 「明日の予定を教えて」「明日のスケジュールを教えて」 | 明日(Asia/Tokyo基準)のprimaryカレンダーの予定を読み上げる |
| 「明日の15時に接続テスト予定を作って」「明日15時に接続テスト予定を入れて」「明日の午後3時に接続テスト予定を作って」 | 明日15:00〜16:00の固定予定「接続テスト予定」の登録確認を行う(この時点ではまだ登録しない) |
| 「はい」「登録して」「確定」「お願いします」「それで登録して」 | 直前の確認待ちの予定をGoogle Calendarへ冪等に登録する |
| 「いいえ」「やめて」「キャンセル」「登録しない」 | 確認待ちの予定をキャンセルする |
| 上記以外 | 「現在は、今日の予定、明日の予定、明日の15時の接続テスト予定の登録に対応しています。」と返す |

## フェーズ1Aで対応しないもの

- Gemini APIによる自由な自然言語からの予定抽出（固定フレーズのみ決定的ルールで判定）
- 出席者の招待・招待メール送信（`sendUpdates: "none"`固定）
- 予定の更新・削除
- 複数カレンダーの選択（`primary`固定）
- 空き時間提案
- Conversate連携・Even Hubプラグイン・バックグラウンド録音
- 複数ユーザー対応（単一ユーザーMVP、内部的に`userId: "single-user"`固定）
- 一般的な質問へのAI回答
- Google Calendar以外の外部サービス連携
- OAuthトークンのFirestore平文保存（refresh tokenはSecret Managerのみで管理）

## フェーズ0.5: 応答タイムアウト・重複送信・表示長の調査機能

フェーズ0（接続仕様確認）に続き、以下を Even G2 実機で確認するための調査用エンドポイント拡張です。

**フェーズ1A以降、この調査機能は環境変数 `ENABLE_PROBE_TESTS`(既定値 `false`)で無効化されています。**
コードは削除しておらず、`ENABLE_PROBE_TESTS=true` にすれば再度有効化できます。Cloud Run本番デプロイでは
常に `false` を設定します。無効時、以下の遅延テスト・表示長テストの発話は特別処理されず、
通常のカレンダーコマンド判定（今日の予定・明日の予定・固定予定作成・確認応答・対応外）に進みます。

- Even AI が何秒まで応答を待つか（タイムアウト挙動）
- 遅延時に同じリクエストを再送するか
- 通常時にもリクエストが重複するか
- G2 上で長い日本語応答や改行がどのように表示されるか
- 通常 JSON レスポンスが実機で問題なく処理されるか

`POST /v1/chat/completions` の最後の `role: "user"` メッセージが以下の**固定フレーズと完全一致**した場合のみ、
通常の固定応答の代わりに調査用の応答を返します（前後の空白・全角空白・末尾の句読点は無視されます）。
一般会話中に数字が含まれるだけでは誤発動しません。

| Even G2での発話例 | 動作 | assistant content |
| --- | --- | --- |
| 「遅延テスト1秒」「一秒遅延テスト」など | 約1000ms待機してから応答 | 1秒の遅延テストに成功しました。 |
| 「遅延テスト3秒」「三秒遅延テスト」など | 約3000ms待機してから応答 | 3秒の遅延テストに成功しました。 |
| 「遅延テスト5秒」「五秒遅延テスト」など | 約5000ms待機してから応答 | 5秒の遅延テストに成功しました。 |
| 「遅延テスト10秒」「十秒遅延テスト」など | 約10000ms待機してから応答 | 10秒の遅延テストに成功しました。 |
| 「表示長テスト」「表示の長さテスト」「表示文字数テスト」 | 即時応答 | 改行を含む複数行の予定確認文（下記参照） |
| 上記以外の発話 | `ENABLE_PROBE_TESTS`に関わらず、通常のカレンダーコマンド判定（今日の予定・明日の予定・固定予定作成・確認応答・対応外）へ進みます |

「表示長テスト」の応答内容（実際の改行文字を含みます）:

```
表示長テストです。
予定名は田中さんとの打ち合わせです。
日時は7月21日火曜日の15時から16時です。
場所は品川です。
同じ時間帯に別の予定があります。
16時から17時に変更できます。
この内容で登録しますか？
```

`stream: true` の場合も同じ内容で既存の SSE 形式（`data: [DONE]` で終了）を維持します。
遅延テストは、指定時間待機した**後に** SSE 送信を開始します。

### requestFingerprint（重複送信調査用）

同一リクエストが再送されているかを調査するため、リクエストごとに SHA-256 の `requestFingerprint` を計算し、
構造化ログに**ハッシュ値のみ**を出力します。ハッシュの元になるのは、固定識別子・`model`・`messages` の件数・
最後の `user` メッセージの内容・その UTF-8 バイト数であり、**Bearer Token は使用しません**。

同一 Cloud Run インスタンス内で、同じ `requestFingerprint` が**過去30秒以内**に何回届いたかを
`duplicateCountWithin30Seconds` としてログに記録します（初回は1、2回目は2、3回目は3、…）。

**重要な制約:**

- この重複カウンターは**調査用**であり、リクエストを拒否する・キャッシュする・`409` を返す・
  Firestore 等に永続化するといった**本番の冪等性実装ではありません**。すべてのリクエストは通常どおり処理されます。
- カウンターは**インメモリ**で、期限切れのエントリと上限件数超過分は自動的に削除されるため、
  メモリが無制限に増え続けることはありません。
- Cloud Run は `min instances: 0` / `max instances: 2` で運用されており、**複数インスタンス間ではこのカウンターは共有されません**。
  そのため、異なるインスタンスに振り分けられた重複リクエストは検知できず、これだけでは完全な重複検知にはなりません。
- 実機確認が完了した後は、この調査用コード（遅延テスト・表示長テスト・fingerprint・重複カウンター）は
  **除去または無効化する予定**です。

### 会話本文について

この調査機能を含め、**会話本文（`content` の実際のテキスト）・assistant 応答本文・APIトークン・
Authorization ヘッダーの値はログに一切保存しません**。ログに出力されるのは、フィールドの型・件数・
ハッシュ値・タイミングなどの構造情報のみです。

## 特徴

- `GET /health` — ヘルスチェック
- `GET /privacy` — ブラウザで閲覧可能な簡易プライバシーポリシー
- `POST /v1/chat/completions` — OpenAI Chat Completions API 互換エンドポイント（通常応答 / SSE ストリーミング応答の両対応）
- `Authorization: Bearer <EVEN_AGENT_TOKEN>` によるシンプルな認証
- リクエストの**構造**（フィールド名・型・件数など）のみを構造化ログに出力し、会話本文やトークンなどの機微情報は一切ログに残さない
- 未知のフィールドを含むリクエストでもエラーにしない寛容な実装

## ディレクトリ構成

```
even-calendar-agent/
├─ src/
│  ├─ index.ts                        # エントリーポイント（起動・実依存関係の組み立て・Graceful Shutdown）
│  ├─ app.ts                          # Express アプリの組み立て（依存性注入ポイント）
│  ├─ routes/
│  │  ├─ health.ts                    # GET /health
│  │  ├─ privacy.ts                   # GET /privacy
│  │  ├─ setup.ts                     # GET/POST /setup, /setup/login, /setup/logout
│  │  ├─ oauth.ts                     # /oauth2/start, /oauth2/callback, /oauth2/status
│  │  └─ chatCompletions.ts           # POST /v1/chat/completions
│  ├─ auth/
│  │  ├─ signedToken.ts               # HMAC署名付きステートレストークンの共通実装
│  │  ├─ setupSession.ts              # /setup管理セッション(30分)
│  │  ├─ oauthState.ts                # OAuth state(CSRF対策)
│  │  ├─ googleOAuthClient.ts         # Google OAuth2Clientのラッパー
│  │  ├─ refreshTokenStore.ts         # refresh tokenのSecret Manager読み書き(5分キャッシュ)
│  │  └─ oauthVerificationTracker.ts  # OAuth最終確認結果のインメモリ保持
│  ├─ calendar/
│  │  ├─ calendarClient.ts            # Google Calendar APIラッパー(+ Fake実装)
│  │  ├─ calendarService.ts           # 日時範囲・RFC3339変換を含む上位サービス
│  │  ├─ calendarFormatter.ts         # 予定一覧の日本語整形
│  │  └─ calendarEventId.ts           # operationId・Google event IDの決定的生成
│  ├─ firestore/
│  │  ├─ models.ts                    # Firestoreドキュメントの型定義
│  │  ├─ firestoreClient.ts           # 本番用Firestoreクライアント生成
│  │  ├─ conversationStateRepository.ts # 確認待ち状態(+ インメモリFake)
│  │  ├─ idempotencyRepository.ts     # 冪等性制御のlease取得ロジック(+ インメモリFake)
│  │  ├─ deliveryDedupeRepository.ts  # 近接重複配送の検知・記録(+ インメモリFake)
│  │  └─ deliveryKey.ts               # 重複検知キーの生成(2秒バケット)
│  ├─ commands/
│  │  ├─ textNormalize.ts             # 発話の正規化(NFKC・句読点除去など)共通処理
│  │  ├─ commandClassifier.ts         # 発話→コマンド種別の決定的分類
│  │  ├─ fixedEventParser.ts          # 固定予定作成フレーズの判定・予定定義生成
│  │  └─ confirmationParser.ts        # 肯定/否定の判定
│  ├─ services/
│  │  ├─ calendarAgentService.ts      # コマンドごとの応答文生成・オーケストレーション
│  │  ├─ idempotentEventCreationService.ts # 正式な冪等性制御付きの予定作成フロー
│  │  └─ openAiCompatibleResponse.ts  # OpenAI互換レスポンス/チャンクの生成
│  ├─ time/
│  │  ├─ clock.ts                     # Clockインターフェース(テストで時刻固定用)
│  │  └─ tokyoDateTime.ts             # Asia/Tokyo基準の日時範囲計算(Luxon)
│  ├─ security/
│  │  ├─ safeLogger.ts                # 許可された安全なフィールドのみを出力するロガー
│  │  ├─ sanitizedError.ts            # エラーを安全な分類コードへ変換
│  │  ├─ timingSafe.ts                # タイミングセーフな文字列比較
│  │  ├─ cookies.ts                   # Cookie読み取りユーティリティ
│  │  └─ instanceId.ts                # プロセス起動時のランダムインスタンスID
│  ├─ middleware/
│  │  ├─ auth.ts                      # Bearer トークン認証
│  │  ├─ requestMetadataLogger.ts     # 調査用の構造化ログ出力
│  │  └─ errorHandler.ts              # グローバルエラーハンドラー / 404
│  ├─ types/
│  │  └─ chat.ts                      # リクエスト/レスポンスの型定義
│  └─ utils/
│     ├─ safeRequestMetadata.ts       # ログ用メタデータの安全な抽出
│     ├─ testModeDetector.ts          # 発話フレーズからテストモードを判定（フェーズ0.5、ENABLE_PROBE_TESTS時のみ）
│     ├─ lastUserMessage.ts           # messages配列から最後のuserメッセージを取得
│     ├─ requestFingerprint.ts        # 重複調査用のSHA-256フィンガープリント生成
│     ├─ duplicateTracker.ts          # フェーズ0.5のインメモリ30秒間重複カウンター(現在は未使用、コードのみ保持)
│     ├─ delay.ts                     # abort対応の待機ユーティリティ
│     └─ traceId.ts                   # X-Cloud-Trace-Contextからのtrace ID抽出
├─ tests/                             # Vitest によるテスト(Fake/モックのみ使用、実GCPには一切アクセスしない)
├─ Dockerfile
├─ .dockerignore
├─ .env.example
├─ package.json
├─ tsconfig.json
└─ README.md
```

## セットアップ

### 必要環境

- Node.js 20 以上
- npm

### インストール

```bash
cd even-calendar-agent
npm install
```

### 環境変数

`.env.example` をコピーして `.env` を作成し、値を設定してください。

```bash
cp .env.example .env
```

| 変数名             | 必須 | デフォルト | 説明                                                                 |
| ------------------ | ---- | ---------- | -------------------------------------------------------------------- |
| `PORT`             | 任意 | `8080`     | サーバーがリッスンするポート。Cloud Run では自動的に注入されます。   |
| `EVEN_AGENT_TOKEN` | 必須 | なし       | Even AI からのリクエストを認証する Bearer トークン。未設定時は起動時にエラー終了します。 |
| `SETUP_ADMIN_TOKEN` | 必須 | なし | `/setup` 管理画面ログイン用のトークン。未設定時は起動時にエラー終了します。 |
| `GOOGLE_OAUTH_CLIENT_ID` | 必須 | なし | Google OAuth Web ClientのClient ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | 必須 | なし | Google OAuth Web ClientのClient Secret |
| `GOOGLE_OAUTH_REDIRECT_URI` | 必須 | なし | OAuth認可コールバックURL(`<サービスURL>/oauth2/callback`) |
| `ENABLE_PROBE_TESTS` | 任意 | `false` | フェーズ0.5の調査コマンド(遅延テスト・表示長テスト)を有効化するか |
| `TIME_ZONE` | 任意 | (コード内でAsia/Tokyo固定) | ドキュメント用途。実際の日時計算は常にAsia/Tokyoで行われます |
| `CALENDAR_ID` | 任意 | `primary` | 操作対象のGoogle Calendar ID |
| `FIRESTORE_DATABASE_ID` | 任意 | `(default)` | 使用するFirestoreデータベースID |
| `GOOGLE_CALENDAR_REFRESH_TOKEN_SECRET` | 任意 | `google-calendar-refresh-token` | refresh tokenを保存するSecret Manager上のSecret名 |

`.env` はコミットしないでください（`.gitignore` で除外済み）。ソースコードにトークンを直接記載することはありません。
`GOOGLE_CALENDAR_REFRESH_TOKEN_SECRET`以外の3つのSecret(`EVEN_AGENT_TOKEN` / `SETUP_ADMIN_TOKEN` /
`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`)はCloud Run環境変数として**固定バージョン**を注入し、
refresh tokenだけは実行時にSecret Manager APIから最新バージョンを読み取ります（詳細は後述）。

## npm スクリプト

| コマンド          | 内容                                              |
| ----------------- | ------------------------------------------------- |
| `npm run dev`     | `tsx watch` によるホットリロード開発サーバー起動  |
| `npm run build`   | `tsc` で `dist/` にトランスパイル                 |
| `npm run start`   | `dist/index.js` を Node.js で実行（本番/本番相当）|
| `npm run lint`    | ESLint による静的解析                             |
| `npm test`        | Vitest によるテスト実行                           |

## ローカルでの動作確認

```bash
npm run dev
```

デフォルトでは `http://localhost:8080` で起動します。

### ヘルスチェック

```bash
curl http://localhost:8080/health
```

```json
{ "status": "ok" }
```

### プライバシーポリシー

ブラウザで `http://localhost:8080/privacy` を開くか、以下で確認できます。

```bash
curl http://localhost:8080/privacy
```

### Chat Completions（通常応答・非ストリーミング）

**curl:**

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <EVEN_AGENT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "even-ai",
    "messages": [
      { "role": "user", "content": "今日の予定を教えて" }
    ],
    "stream": false
  }'
```

**PowerShell (Invoke-RestMethod):**

```powershell
Invoke-RestMethod -Uri "http://localhost:8080/v1/chat/completions" `
  -Method Post `
  -Headers @{ Authorization = "Bearer <EVEN_AGENT_TOKEN>" } `
  -ContentType "application/json" `
  -Body '{"model":"even-ai","messages":[{"role":"user","content":"今日の予定を教えて"}],"stream":false}'
```

**期待されるレスポンス（Google Calendar未連携の場合）:**

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "even-calendar-agent-probe",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Googleカレンダーが未連携です。セットアップ画面で連携してください。"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

Google Calendarと連携済みの場合は、実際の今日の予定一覧（または「今日の予定はありません。」）が返ります。

### Chat Completions（SSE ストリーミング応答）

**curl:**

```bash
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer <EVEN_AGENT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "even-ai",
    "messages": [
      { "role": "user", "content": "今日の予定を教えて" }
    ],
    "stream": true
  }'
```

`-N` はバッファリングを無効にし、チャンクが届き次第表示するためのオプションです。

**PowerShell:**

PowerShell の `Invoke-RestMethod` はストリーミングのチャンクを逐次表示するのに向いていないため、
ストリーミング確認には curl（Windows 10/11 標準搭載の `curl.exe`）の利用を推奨します。

```powershell
curl.exe -N -X POST http://localhost:8080/v1/chat/completions `
  -H "Authorization: Bearer <EVEN_AGENT_TOKEN>" `
  -H "Content-Type: application/json" `
  -d '{\"model\":\"even-ai\",\"messages\":[{\"role\":\"user\",\"content\":\"今日の予定を教えて\"}],\"stream\":true}'
```

**期待される出力（抜粋、Google Calendar未連携の場合）:**

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1730000000,"model":"even-calendar-agent-probe","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1730000000,"model":"even-calendar-agent-probe","choices":[{"index":0,"delta":{"content":"Googleカレンダーが未連携です。セットアップ画面で連携してください。"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1730000000,"model":"even-calendar-agent-probe","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### 認証エラーの確認（401）

```bash
curl -i -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test"}]}'
```

`Authorization` ヘッダーが無い、または `EVEN_AGENT_TOKEN` と一致しない場合、`401 Unauthorized` が返ります。

## 調査用ログについて

`POST /v1/chat/completions` を受信すると、以下の情報のみを構造化ログ（JSON 1行、`chat_completions_request_received`）として出力します。

- リクエスト受信日時、HTTP メソッド、パス
- `Content-Type`、`User-Agent`
- Authorization ヘッダーの有無、Bearer 方式かどうか（**値そのものは出力しません**）
- JSON ボディのトップレベルフィールド名とその型
- `model` / `messages` / `stream` / `user` の有無、`messages` の要素数、各 `message` の `role`、`content` の型
- `stream` の値
- 上記以外の未知フィールド名
- リクエスト本文のバイト数

応答完了時には、構造化ログ（`chat_completions_response_sent`）も出力します。フェーズ1Aでは、記録するフィールドを
安全性を検証しやすいよう以下の一覧に整理しています。

- `requestFingerprint`（重複調査用のSHA-256ハッシュ値。会話本文やトークンそのものは含みません）
- `durationMs` / `traceId`（`X-Cloud-Trace-Context` の先頭のtrace IDのみ） / `httpStatus` / `responseType`（`json`または`sse`）
- `duplicateDetected`（Firestoreの`deliveryDedupe`による、同一内容の近接重複配送の検知結果）
- `instanceId`（プロセス起動時に生成するランダムなインスタンス識別子。複数インスタンスへの分散調査用）
- `testMode`（`ENABLE_PROBE_TESTS=true`時のみ。フェーズ0.5の調査コマンドが発火した場合だけ含まれます）
- `commandType` / `actionType` / `oauthConnected` / `firestoreOperation` / `idempotencyStatus` /
  `calendarApiOperation` / `calendarApiResultCode` / `sanitizedErrorCode` / `leaseAcquired` / `reusedCompletedResult`
  （フェーズ1Aのカレンダーコマンド処理時のみ、該当する項目だけ含まれます）

遅延テスト中にクライアントが切断した場合は `chat_completions_client_disconnected` を出力します
（`requestFingerprint` / `clientDisconnected: true` / `configuredDelayMs` / `elapsedMs` / `instanceId` のみ）。

**会話本文、assistant応答本文、予定タイトル、予定日時、Calendar APIのイベント本文・htmlLink、Google Calendar
event IDの生値、OAuth認可コード、access token、refresh token、client secret、setup admin token、
Authorizationヘッダー値、Bearer Token、Cookie値、OAuth state、Google APIの生レスポンス本文、Secret Managerの値、
Firestoreドキュメント全体は一切ログに出力・保存しません。** 例外を`console.error(error)`のようにそのまま
出力することもなく、`sanitizeError()`でエラーを安全な分類コード（例: `server_error` / `auth_invalid_grant` /
`duplicate_id` など）へ変換してからログに残します。
詳細は [`GET /privacy`](#プライバシーポリシー) のポリシーページも参照してください。

## フェーズ1A: Google Calendar連携基盤

### Google OAuthセットアップ手順

1. Google Cloud Consoleで対象プロジェクトのOAuth同意画面を設定します（User Type: External、公開状態: Testing、
   操作したいGoogleアカウントをテストユーザーへ追加）。
2. 「認証情報を作成」→「OAuthクライアントID」で、アプリケーションの種類を **ウェブ アプリケーション** として作成します。
3. 承認済みのリダイレクトURIに、実際のCloud RunサービスURLを使って以下を登録します。

   ```
   https://<サービスURL>/oauth2/callback
   ```

4. 発行されたClient ID / Client Secretを、Secret Manager（`google-oauth-client-id` / `google-oauth-client-secret`）へ
   `--data-file` 経由で登録します（コマンド引数に値を直接書かない）。値は画面・ログ・完了報告に表示しません。
5. ブラウザで `https://<サービスURL>/setup` を開き、`SETUP_ADMIN_TOKEN` でログインします。
6. 「Googleカレンダーと連携する」リンクから `/oauth2/start` へ進み、Googleの同意画面で許可します。
7. `/oauth2/callback` が成功すると、refresh tokenがSecret Manager上の`google-calendar-refresh-token`へ
   新しいバージョンとして自動保存されます。画面にはトークン値は一切表示されません。
8. `/oauth2/status` で `connected: true` になっていることを確認します。

### 必要なOAuthスコープ

```
https://www.googleapis.com/auth/calendar.events.owned
```

このスコープのみで、`primary`カレンダーの予定参照(`events.list`)・自分が作成した予定への操作(`events.insert`/`events.get`)が
可能です。より広い `https://www.googleapis.com/auth/calendar` スコープは、招待者管理や他ユーザー作成イベントの編集など
フェーズ1Aで不要な権限まで含むため使用していません。

認可URLには以下を指定しています。

- `access_type=offline`（refresh tokenを取得するため）
- `include_granted_scopes=true`
- `prompt=consent`（再連携時も確実にrefresh tokenを再取得するため）
- `state`（暗号学的に安全な乱数。署名付きHttpOnly Cookieに保存し、コールバックで完全一致を検証）

### redirect URI

```
https://<サービスURL>/oauth2/callback
```

Google Cloud ConsoleのOAuthクライアント設定と、環境変数`GOOGLE_OAUTH_REDIRECT_URI`の両方に、
**完全に同じ値**を設定する必要があります。

### Secret一覧

| Secret名 | 内容 | Cloud Runでの利用方法 |
| --- | --- | --- |
| `even-agent-token` | Even AIからの認証用Bearer Token | 環境変数`EVEN_AGENT_TOKEN`(固定バージョン) |
| `even-setup-admin-token` | `/setup`管理ログイン用トークン | 環境変数`SETUP_ADMIN_TOKEN`(固定バージョン) |
| `google-oauth-client-id` | OAuth Client ID | 環境変数`GOOGLE_OAUTH_CLIENT_ID`(固定バージョン) |
| `google-oauth-client-secret` | OAuth Client Secret | 環境変数`GOOGLE_OAUTH_CLIENT_SECRET`(固定バージョン) |
| `google-calendar-refresh-token` | Google Calendar refresh token | **実行時にSecret Manager APIから最新バージョンを読み取り**、環境変数へは注入しない |

実行サービスアカウント(`even-calendar-agent-sa`)には、Secretごとに最小権限のIAMのみを付与しています。

- 上記5Secretすべてに `roles/secretmanager.secretAccessor`
- `google-calendar-refresh-token` にのみ `roles/secretmanager.secretVersionAdder`（OAuth連携完了時に新バージョンを追加するため）
- プロジェクト全体には `roles/datastore.user` のみ（Firestoreのサーバーサイド読み書き用。IndexやTTLなどの管理操作権限は含まない）

Owner/Editor/Secret Manager Adminなどの広い権限は付与していません。

### Firestoreデータモデル

単一ユーザーMVPとして、すべて`userId: "single-user"`で運用します。

**`conversationStates/{userId}`** — 確認待ちの予定

```
state: "awaiting_confirmation"
actionType: "create_event"
operationId, calendarId, event{ summary, startDateTime, endDateTime, timeZone, description }
createdAt, updatedAt, expiresAt(作成から10分), version
```

新しい予定作成発話が来ると既存の確認待ち状態を置き換えます。読み取り時に`expiresAt`をアプリ側で必ず評価し、
TTLによる物理削除がまだ行われていなくても期限切れとして扱います。

**`idempotency/{operationId}`** — 冪等性制御(保持期限30日)

```
status: "pending" | "processing" | "completed" | "failed"
leaseOwner, leaseExpiresAt, attemptCount
googleEventId, resultCode, lastErrorCode(サニタイズ済み分類値のみ)
createdAt, updatedAt, completedAt, expiresAt
```

Google Calendarのイベント内容やOAuth情報、Google APIの生エラーはここへ保存しません。

**`deliveryDedupe/{deliveryKey}`** — Even AIからの近接重複配送調査用(保持期限10分)

```
deliveryKey, requestFingerprint, operationId, actionType, createdAt, expiresAt
```

`deliveryKey`は`requestFingerprint`と2秒単位の時刻バケットから生成します。実機調査で確認された
数ミリ秒〜数十ミリ秒差の重複配送だけを吸収し、数秒以上離れた正当な再発話（例: 別のタイミングでの「はい」）
まで誤って重複扱いしないための設計です。会話本文・Authorization値・Bearer Token・assistant回答本文は保存しません。
なお、このコレクションは調査・ログ記録用であり、Calendar書き込みの正しさは後述の`idempotency`コレクションに
よる冪等性制御で保証しています（`deliveryDedupe`だけでは重複実行を防げません）。

### TTL（現時点では未設定）

以下のcollection groupの`expiresAt`にTTLを設定する想定ですが、**フェーズ1Aでは実設定していません**
（ユーザーの明示的な承認後に別途実施します）。

```bash
gcloud firestore fields ttls update expiresAt --collection-group=conversationStates --enable-ttl --database="(default)"
gcloud firestore fields ttls update expiresAt --collection-group=idempotency        --enable-ttl --database="(default)"
gcloud firestore fields ttls update expiresAt --collection-group=deliveryDedupe     --enable-ttl --database="(default)"
```

必要なロール: `roles/datastore.indexAdmin`相当のフィールド管理権限（プロジェクトOwnerであれば追加付与不要）。
実行サービスアカウント(`even-calendar-agent-sa`、`roles/datastore.user`のみ)には付与していません。TTLは
バックグラウンドで遅延実行されるため、**実装側は必ず`expiresAt`をアプリケーションコードで評価**しており、
TTL未設定・削除未実行でも期限切れデータを利用しない設計になっています。

### 冪等性設計

Firestoreトランザクション内でGoogle Calendar APIを呼び出さない設計です（トランザクションが再実行される
可能性があるため）。`confirmAndCreateEvent`（`src/services/idempotentEventCreationService.ts`）の流れ:

1. 確認待ち状態(`conversationStates`)を読み取り、期限切れなら中断
2. `idempotency/{operationId}`をFirestoreトランザクションで取得・判定（**トランザクション内はFirestore操作のみ**）
   - `completed`なら再実行せず既存結果を再利用
   - `processing`かつlease有効なら新規実行せず、最大2.5秒ほど短い間隔で完了を再確認
   - それ以外(未作成/`pending`/`failed`/lease期限切れ)ならleaseを取得(`processing`, 30秒間有効)
3. トランザクションの**外側**でGoogle Calendar `events.insert`を実行
4. 成功: `idempotency`を`completed`に更新し、確認待ち状態を解除
5. Googleから「同じevent IDが既に存在する」(409)が返った場合: `events.get`で存在確認し、存在すれば成功扱い
6. 一時エラー: `status=failed`とサニタイズ済みエラーコードのみ保存し、確認待ち状態は再試行可能な形で残す
7. 認証エラー: `status=failed`とし、ユーザーへ再連携が必要であることを案内

同じ「はい」が同時に複数届いても、Google Calendar APIへの実質的な作成呼び出しは高々1回になるよう
テストしています（`tests/idempotentEventCreationService.test.ts` / `tests/chatCompletions.test.ts`）。

### Google独自event ID

`operationId`は、`userId` / `calendarId` / `summary` / 開始日時 / 終了日時 / `timeZone` からSHA-256で
決定的に生成します（Bearer Tokenは含みません）。Google Calendarへ登録する際の独自event IDは、
`operationId`をさらにSHA-256でハッシュ化した小文字16進数文字列です。Google Calendar公式のevent ID要件
（base32hexで使用される文字 `0-9`, `a-v`、長さ5〜1024文字）は、16進数（`0-9a-f`）が`a-v`の部分集合であるため
自動的に満たされます。予定作成時は`extendedProperties.private`に`source: "even-calendar-agent"`と
`operationId`を設定し、`sendUpdates: "none"`で招待メールを送信しません。

### Even AIの重複配送前提

実機調査（フェーズ0.5）で、Even AIから同一内容のHTTPリクエストが数ミリ秒差で複数届く場合があることを
確認しています。そのため、Google Calendarへの書き込みは**at-least-once配送を前提**に設計しています
（`duplicateDetected`によるログ記録に加え、`idempotency`コレクションによる正式な冪等性制御で実質的な
重複実行を防止）。

### 会話状態をサーバー側で保持する理由

実機調査で、Even AIは過去の会話履歴を`messages`配列に含めず、今回の発話だけを送信する可能性が高いことを
確認しています。そのため「はい」がどの予定作成に対する返事かは、クライアント側の会話履歴に頼らず、
Cloud Run側のFirestore（`conversationStates`）で保持しています。

## Docker

### イメージのビルド

```bash
docker build -t even-calendar-agent .
```

### コンテナの起動

```bash
docker run --rm -p 8080:8080 \
  -e EVEN_AGENT_TOKEN="your-strong-random-token" \
  even-calendar-agent
```

## Google Cloud Run へのデプロイ

Cloud Run は**未認証アクセスを許可**し、アプリ内部の Bearer トークン（`EVEN_AGENT_TOKEN`）で認証する構成を想定しています。
フェーズ1Aでは、これに加えて`/setup`管理画面用のトークンとOAuth関連のSecretが必要です。

```bash
gcloud run deploy even-calendar-agent-probe \
  --project=<PROJECT_ID> \
  --region=asia-northeast1 \
  --source=. \
  --cpu=1 --memory=512Mi \
  --min-instances=0 --max-instances=2 \
  --concurrency=20 --timeout=60 \
  --allow-unauthenticated \
  --service-account=even-calendar-agent-sa@<PROJECT_ID>.iam.gserviceaccount.com \
  --set-env-vars="ENABLE_PROBE_TESTS=false,TIME_ZONE=Asia/Tokyo,CALENDAR_ID=primary,FIRESTORE_DATABASE_ID=(default),GOOGLE_OAUTH_REDIRECT_URI=https://<サービスURL>/oauth2/callback,GOOGLE_CALENDAR_REFRESH_TOKEN_SECRET=google-calendar-refresh-token" \
  --set-secrets="EVEN_AGENT_TOKEN=even-agent-token:<version>,SETUP_ADMIN_TOKEN=even-setup-admin-token:<version>,GOOGLE_OAUTH_CLIENT_ID=google-oauth-client-id:<version>,GOOGLE_OAUTH_CLIENT_SECRET=google-oauth-client-secret:<version>"
```

- `--allow-unauthenticated` により Cloud Run のIAM認証は無効化し、代わりにアプリ内の Bearer トークン(`/v1/chat/completions`)と
  署名付きセッションCookie(`/setup`, `/oauth2/*`)で保護します。
- Secretは**必ず具体的なバージョン番号**を指定してください（`latest`は使用しません）。`google-calendar-refresh-token`だけは
  Cloud Run環境変数へ注入せず、アプリが実行時にSecret Manager APIから最新バージョンを読み取ります。
- `PORT` は Cloud Run が自動的に注入するため、明示的に設定する必要はありません。

### デプロイ後の疎通確認

```bash
curl https://<CLOUD_RUN_URL>/health
curl https://<CLOUD_RUN_URL>/privacy
```

## セキュリティ上の注意

- `/setup`・`/oauth2/*`はCloud RunのIAM認証を経由しないため、アプリ内の管理セッション(`SETUP_ADMIN_TOKEN`で発行される
  署名付きHttpOnly Cookie、30分有効)が唯一の防御層です。`SETUP_ADMIN_TOKEN`は他のSecretと同様、推測困難な値を使用し、
  第三者と共有しないでください。
- 管理セッションCookieは`Secure` / `HttpOnly` / `SameSite=Lax` / `Path=/`で発行され、`SETUP_ADMIN_TOKEN`自体は
  Cookieへ格納しません（HMAC署名付きの短時間ステートレスセッション）。
- OAuth stateは暗号学的に安全な乱数を署名付きHttpOnly Cookieに保存し、コールバックで完全一致を検証後に削除します。
- access tokenはFirestore・Secret Managerへ永続化しません（googleapisライブラリがメモリ上でのみ保持・更新します）。
- refresh tokenはSecret Manager以外（Firestore・ローカルファイル・ログ・ブラウザ応答）に一切保存・表示しません。

## OAuth再連携方法 / refresh tokenが無効化された場合

Googleアカウント側でのアクセス取り消し、長期間未使用による自動失効、パスワード変更などでrefresh tokenが
無効になることがあります。この場合、Calendar API呼び出しが認証エラーとなり、Even AIには
「Googleカレンダーとの連携が無効になっています。セットアップ画面で再連携してください。」と返されます。

再連携手順:

1. `https://<サービスURL>/setup` で管理ログイン
2. 「Googleカレンダーと連携する」から`/oauth2/start`を再実行（`prompt=consent`により毎回同意画面が表示されます）
3. 新しいrefresh tokenが`google-calendar-refresh-token`の新バージョンとして自動保存されます
4. `/oauth2/status`で`connected: true`・検証成功を確認

## 実機テスト手順（フェーズ1A）

実際にCalendarへ書き込みを行う前に、必ず以下の順で確認してください（詳細はデプロイ時の完了報告を参照）。

1. `/setup`でOAuth連携状態(`connected: true`)と検証成功を確認
2. Even G2で「今日の予定を教えて」「明日の予定を教えて」を発話し、実際の予定が読み上げられることを確認
3. 「明日の15時に接続テスト予定を作って」で確認質問が返ることを確認（この時点ではまだ登録されない）
4. 実際にカレンダーへ書き込む前に、担当者が読み取り・OAuth・Firestore状態保存・冪等性テストの結果を確認
5. 承認後にのみ「はい」を発話し、初回登録を実施
6. Google Calendar上に1件だけ登録されていること、同じ「はい」を再送しても2件目が作られないことを確認

## トラブルシューティング

| 症状 | 確認すること |
| --- | --- |
| `Googleカレンダーが未連携です`と返る | `/oauth2/status`で`connected`を確認。未連携なら`/setup`から連携する |
| `Googleカレンダーとの連携が無効になっています`と返る | refresh tokenが失効している可能性。`/oauth2/start`から再連携する |
| `一時的なエラーが発生しました`と返る | Calendar APIの一時的な障害・レート制限の可能性。少し時間を置いて再試行する |
| `登録処理中です。少し待ってから確認してください` | 同時に届いた別リクエストがleaseを保持中。数秒待って再度「はい」を送る |
| `/setup`にログインできない | `SETUP_ADMIN_TOKEN`の値と、`.secrets/even-setup-admin-token.txt`の内容が一致しているか確認 |
| OAuthコールバックが400になる | stateの不一致・有効期限切れ（10分）。`/oauth2/start`からやり直す |

## 次フェーズの予定

フェーズ1Bで、Gemini APIによる自由な自然言語からの予定抽出・登録を追加予定です
（本バージョンのフェーズ1Aには含まれていません）。

## 既知の制約・未確認事項

- Even AI が実際に送信するリクエストの正確な形式（ヘッダー構成、追加フィールドの有無など）は完全には未確認です。
  本サーバーは未知のフィールドを許容する寛容な実装にしていますが、実際の Even AI からのリクエストを
  受信した際のログを確認しながら、今後仕様を確定させていく想定です。
- Gemini連携は本バージョンには含まれていません（フェーズ1Bで追加予定）。
- 会話履歴そのものの永続化は行っていません。確認待ちの予定情報のみFirestoreへ一時保存します（最大10分）。
- フェーズ0.5の遅延テスト・表示長テストは`ENABLE_PROBE_TESTS=true`のときのみ有効な調査用機能です。
  本番デプロイでは`false`に設定します。
- `deliveryDedupe`によるduplicateDetectedは調査・記録が目的であり、それ単体ではCalendar書き込みの重複防止を
  保証しません（重複防止は`idempotency`コレクションによる正式な冪等性制御で担保しています）。
- TTL（`conversationStates` / `idempotency` / `deliveryDedupe`）はフェーズ1A時点では未設定です。
  アプリ側で`expiresAt`を必ず評価するため機能上の問題はありませんが、Firestoreのストレージ使用量は
  TTL未設定の間は自動削除されません。
- OAuth同意画面は現在「Testing」公開状態です。テストユーザーとして登録したアカウント以外では認可できません。
- `/setup`・`/oauth2/*`はCloud RunのIAM認証を経由しないため、`SETUP_ADMIN_TOKEN`の管理が重要です。
