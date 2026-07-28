import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// フェーズ2J: `vite build --mode product` はプロジェクトルートの .env.local を一切読み込まない
// (envDirを空の専用ディレクトリへ差し替える)。ローカル開発者の .env.local が残っていても
// 製品ビルドの再現性・安全性に影響しない(CIでも同じ結果になる)。
// 二重の安全策として、devセッション用の値をbuild時にリテラル空文字へ固定する(define)。
export default defineConfig(({ mode }) => {
  const isProduct = mode === 'product'

  return {
    server: { host: true, port: 5173 },
    build: {
      target: 'esnext',
      sourcemap: false,
    },
    ...(isProduct
      ? {
          envDir: path.resolve(dirname, 'env/product-empty'),
          define: {
            'import.meta.env.VITE_PLUGIN_SESSION_TOKEN': JSON.stringify(''),
            'import.meta.env.VITE_PLUGIN_INSTALL_ID': JSON.stringify(''),
          },
        }
      : {}),
  }
})
