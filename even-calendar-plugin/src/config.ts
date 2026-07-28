// バックエンドのベースURL。app.json の network whitelist と必ず一致させること。
export const BACKEND_BASE_URL = 'https://even-calendar-agent-probe-1082947954310.asia-northeast1.run.app'

// ローカル実機開発専用のセッション情報。scripts/create-dev-session.ps1 が .env.local へ書き込む。
// 本番配布用の値ではない(平文をソースやビルド成果物に埋め込まない設計)。
export const PLUGIN_SESSION_TOKEN: string = import.meta.env.VITE_PLUGIN_SESSION_TOKEN ?? ''
export const PLUGIN_INSTALL_ID: string = import.meta.env.VITE_PLUGIN_INSTALL_ID ?? ''
