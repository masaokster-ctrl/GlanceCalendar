import { describe, expect, it } from 'vitest';
import { delay } from '../src/utils/delay.js';

describe('delay', () => {
  it('resolves immediately for zero or negative ms', async () => {
    await expect(delay(0)).resolves.toBeUndefined();
    await expect(delay(-5)).resolves.toBeUndefined();
  });

  it('resolves after the given time', async () => {
    const start = Date.now();
    await delay(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delay(1000, controller.signal)).rejects.toThrow();
  });

  it('rejects when aborted mid-wait', async () => {
    const controller = new AbortController();
    const promise = delay(1000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow();
  });
});
