import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createTestApp, TEST_AGENT_TOKEN } from './testHelpers.js';
import { delay } from '../src/utils/delay.js';
import type { DelayFn } from '../src/utils/delay.js';

const TOKEN = TEST_AGENT_TOKEN;

// 実際の待機は短時間(200ms)に固定した delayFn を注入し、テストを高速化しつつ
// AbortSignal によるキャンセル経路(実装の delay.ts)を本物に近い形で検証する。
const shortRealDelay: DelayFn = (_ms, signal) => delay(200, signal);

describe('client disconnect during delay', () => {
  it('logs clientDisconnected and does not attempt to write to the closed response', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = createTestApp({ delayFn: shortRealDelay, enableProbeTests: true });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('failed to bind test server');
    }
    const port = address.port;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
        () => {
          // 応答が届いてしまった場合はテスト失敗として扱う
        },
      );

      req.on('error', () => {
        // クライアント側で破棄した際のソケットエラーは想定内なので無視する
      });

      req.write(JSON.stringify({ messages: [{ role: 'user', content: '遅延テスト1秒' }] }));
      req.end();

      setTimeout(() => {
        req.destroy();
        setTimeout(resolve, 300);
      }, 50);

      setTimeout(() => reject(new Error('test timed out')), 2000);
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));

    const disconnectLog = logSpy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line));
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.event === 'chat_completions_client_disconnected');

    expect(disconnectLog).toBeDefined();
    expect(disconnectLog.clientDisconnected).toBe(true);
    expect(disconnectLog.configuredDelayMs).toBe(1000);
    expect(typeof disconnectLog.elapsedMs).toBe('number');
    expect(typeof disconnectLog.requestFingerprint).toBe('string');

    const allLogText = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((call) => call.join(' ')).join('\n');
    expect(allLogText).not.toContain(TOKEN);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
