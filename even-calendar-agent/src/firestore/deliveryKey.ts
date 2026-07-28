import { createHash } from 'node:crypto';

const TIME_BUCKET_MS = 2000;

/**
 * requestFingerprintと短い時間バケット(2秒単位)からdeliveryKeyを生成する。
 * 実機調査で確認された数ミリ秒〜数十ミリ秒差の重複配送だけを吸収し、
 * 数秒以上離れた正当な再発話(同じ発話内容でも別の操作)まで誤って
 * 重複扱いしないようにするための設計判断。
 */
export function computeDeliveryKey(requestFingerprint: string, now: Date): string {
  const bucket = Math.floor(now.getTime() / TIME_BUCKET_MS);
  return createHash('sha256').update(`${requestFingerprint}:${bucket}`, 'utf8').digest('hex');
}
