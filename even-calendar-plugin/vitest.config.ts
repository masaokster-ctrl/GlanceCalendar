import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // bare `createApp(bridge)`呼び出しのテスト(dev mode前提)が.env.localの有無に依存しないよう、
    // テスト実行専用の固定fixture値を与える(実際のdev session token/installIdとは無関係)。
    env: {
      VITE_PLUGIN_SESSION_TOKEN: 'test-fixture-session-token',
      VITE_PLUGIN_INSTALL_ID: '00000000-0000-4000-8000-000000000000',
    },
  },
})
