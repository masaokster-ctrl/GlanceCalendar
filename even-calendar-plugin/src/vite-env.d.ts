/// <reference types="vite/client" />

interface ImportMetaEnv {
  // ローカル実機開発専用(scripts/create-dev-session.ps1 が発行・保存する)。本番配布方式ではない。
  readonly VITE_PLUGIN_SESSION_TOKEN?: string
  readonly VITE_PLUGIN_INSTALL_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
