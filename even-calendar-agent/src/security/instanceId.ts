import { randomUUID } from 'node:crypto';

/**
 * Cloud Runはアプリへ真のインスタンスIDを公式な方法で公開していないため、
 * プロセス起動時に1度だけランダムな識別子を生成し、以後同一インスタンスからの
 * ログ相関に使う(複数インスタンスへの分散有無を安全なログだけで調査するため)。
 */
export const instanceId: string = randomUUID();
