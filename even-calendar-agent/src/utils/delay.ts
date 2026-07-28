export type DelayFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * 指定ミリ秒待機する。signal が abort された場合は待機を中断して reject する
 * （クライアント切断時に処理を中断するために使用）。
 */
export const delay: DelayFn = (ms, signal) => {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('delay aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('delay aborted'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
};
