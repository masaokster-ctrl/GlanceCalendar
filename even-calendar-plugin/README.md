# even-calendar-plugin (フェーズ2C: 音声予定解析 + 確認画面)

Even G2上で動作する、音声入力型Calendarプラグインです。

## 目的

フェーズ2Cの目的は **G2で録音した音声を安全にバックエンドへ送信し、Geminiで構造化した予定候補または
確認質問をG2に表示すること** です。以下は**まだ実装していません**。

- Google Calendarへの実登録(`event_candidate`画面の「次へ」を押してもCalendarには登録されません)
- `needs_clarification`後の追加入力との会話継続(現時点では押すとホーム→ユーザーが手動で再録音)
- 本番配布(Developer Portal公開・Private/Betaビルド)

## 画面フロー

1. **ホーム** — 「押して話す」。単押しで録音開始、下スワイプ/上スワイプでプレースホルダー画面、二度押しで終了
2. **録音中** — 単押しで停止、二度押しでキャンセル。最大30秒で自動停止、0.5秒未満は「短すぎます」
3. **録音完了** — 取得した音声の長さを表示。単押しでWAV変換・送信を開始、二度押しでやり直し(再録音)
4. **解析中** — 「解析中... しばらくお待ちください」。単押しは無視。二度押しで送信を中止しホームへ
5. **予定確認** (`event_candidate`) — タイトルと`M/D HH:mm-HH:mm`を表示。押す: 次へ(登録は未実装)、二度押し: 中止
6. **次の段階プレースホルダー** — 「登録機能は次の段階で追加します」。押す/二度押しでホームへ
7. **確認が必要です** (`needs_clarification`) — Geminiからの確認質問を表示。押す: ホームへ戻り再録音、二度押し: 中止
8. **予定の内容を話してください** (`not_calendar_request`) — 押す/二度押しでホームへ
9. **今日/明日プレースホルダー** — 「次の段階で接続します」。押す/二度押しでホームへ

すべて単一のテキストコンテナ(576×288、`isEventCapture:1`)の内容を`textContainerUpgrade`で
書き換える方式で実装しており、レイアウト変更(`rebuildPageContainer`)は発生しません。

## ディレクトリ構成

```
src/
├─ main.ts               # エントリーポイント(bridge取得・起動・後片付け)
├─ app.ts                 # 画面遷移・録音制御・解析制御・イベントルーティングの中核
├─ recordingState.ts      # 録音ライフサイクルの純粋な状態機械
├─ analysisState.ts       # 音声解析ライフサイクルの純粋な状態機械(idle/analyzing/succeeded/cancelled/error)
├─ recorder.ts            # PCMバッファ管理(最大30秒キャップ、秒数計算)
├─ wav.ts                 # RIFF/WAVEヘッダー生成ユーティリティ(解析送信前のWAV変換に使用)
├─ eventCandidate.ts       # /plugin/analyze-audio レスポンスの型・独立検証(過去日時/end<=start等)
├─ analyzeAudioClient.ts   # WAVの認証付きPOST(タイムアウト・キャンセル・自動リトライなし)
├─ screens.ts              # 各画面のテキスト生成(純粋関数、長い文字列は安全に省略)
├─ backendHealth.ts        # GET /health の疎通確認(Authorizationなし、5秒タイムアウト)
├─ storage.ts              # bridge.setLocalStorage/getLocalStorageの安全なラッパー
├─ safeLog.ts              # 許可フィールドのみを出力する構造化ログ
├─ errors.ts               # エラーコード → 安全な日本語メッセージ
├─ config.ts               # バックエンドURL・開発用セッション情報(環境変数)
└─ ui.ts                   # コンパニオンWebView側の最小表示

scripts/
└─ create-dev-session.ps1  # ローカル実機開発専用: 開発用セッショントークンを発行し.env.localへ保存
```

## 音声仕様

- G2 four-mic、`AudioInputSource.Glasses`
- PCM signed 16-bit little-endian, 16kHz, mono
- 秒数 = バイト数 / (16000 × 2)
- 最大30秒分だけメモリ上に保持(超過分は自動的に録音終了)
- 0.5秒未満はエラーではなく「短すぎます」画面として扱う
- 解析開始時にPCMをWAV(44バイトヘッダー)へ変換し、送信完了または中止後に参照を解放する
- WAV/PCMはlocalStorage・IndexedDB・File APIのいずれにも保存しない

## 音声解析 (`/plugin/analyze-audio`) 統合

- **開発用セッション**: `VITE_PLUGIN_SESSION_TOKEN`/`VITE_PLUGIN_INSTALL_ID`(`.env.local`、
  `scripts/create-dev-session.ps1`が発行)。既存の`even-agent-token`/`even-setup-admin-token`は
  プラグインへ一切埋め込まない。**この方式はローカル実機開発専用であり、本番配布方式ではない。**
- リクエスト: `POST /plugin/analyze-audio`、`Content-Type: audio/wav`、
  `Authorization: Bearer <session token>`、`X-Install-Id`、`X-Request-Id`(UUID、リクエストごとに生成)
- タイムアウト35秒、自動リトライなし。二度押しでAbortControllerによる即座の中止が可能
- 中止後に遅延して届いたレスポンスは画面へ反映しない
- レスポンスの日時(`startLocal`/`endLocal`)はクライアント側でも独立に再検証する
  (不正フォーマット・過去日時・`endLocal <= startLocal`はすべて解析失敗として扱う)
- サーバーからの応答はHTMLとして解釈せず、常にプレーンテキストとしてG2へ表示する

## ログ・永続化の方針

- ログに出すのは状態名・成功失敗・チャンク件数・バイト数・秒数・resultType・エラーコードなどの
  安全な値のみ
- PCM本体、WAV本体、発話内容、予定名、日時、Token、installId生値、Secret、Calendar/OAuth情報は
  ログにもストレージにも一切残さない
- 永続化は `bridge.setLocalStorage`/`getLocalStorage` のみを使用する
  (このFlutter WebView環境ではブラウザの`window.localStorage`が再起動時に確実に永続化されないため)
- 保存するのは `backendAvailable` の真偽値だけ
- バックグラウンド復帰時は録音・解析状態を復元せず、常に`idle`/ホーム画面へ戻る

## セットアップ

```bash
npm install
npm run dev                                       # Vite開発サーバー
npm run simulate                                   # デスクトップSimulator
./scripts/create-dev-session.ps1                    # 開発用セッションを発行(.env.localへ保存)
npx evenhub-cli qr --url http://<your-ip>:5173      # 実機用QRコード
npx evenhub-cli pack app.json dist --check          # package_id利用可否確認(要 evenhub login)
```

`.env.local`を新規発行・更新した場合は、Vite dev serverを再起動(または環境変数を再読込)してください。

## 検証

```bash
npm run lint
npm test
npm run build
npm audit --omit=dev
```

## 既知の制約

- `package_id`(`com.masa.even.calendar`)の利用可否は、Even Hubアカウントへのログインが必要なため
  未確認です。`npx evenhub login` の後に `npx evenhub-cli pack app.json dist --check` で確認してください。
- 開発時の`npm audit`には、開発ツールチェーンに起因する既知の脆弱性が表示されることがありますが、
  いずれも本番依存関係には影響しません(`npm audit --omit=dev` は0件であることを確認済み)。
- `scripts/create-dev-session.ps1`が発行するセッションはローカル実機開発専用です。
  Developer Portalへの公開やPrivate/Betaビルドなど、本番配布には使用しないでください。
