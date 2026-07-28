import type { Clock } from '../time/clock.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface RefreshTokenStore {
  /** 最新の有効versionを読み取る。versionが存在しない場合はnull(未連携)を返す。 */
  getRefreshToken(): Promise<string | null>;
  /** 値が空でない場合のみ新しいSecret versionとして保存する。 */
  saveRefreshToken(value: string): Promise<void>;
  invalidateCache(): void;
}

// SecretManagerServiceClientのうち実際に使用する2メソッドだけを要求する最小インターフェース。
// テストではFakeを注入できるようにするための設計。
export interface SecretManagerClientLike {
  accessSecretVersion(request: {
    name: string;
  }): Promise<[{ payload?: { data?: Uint8Array | string | null } | null }, ...unknown[]]>;
  addSecretVersion(request: { parent: string; payload: { data: Buffer } }): Promise<[unknown, ...unknown[]]>;
}

export interface SecretManagerRefreshTokenStoreConfig {
  client: SecretManagerClientLike;
  projectId: string;
  secretName: string;
  clock: Clock;
}

/**
 * Secret Managerからrefresh tokenの最新有効versionを読み取る。
 * 最大5分間メモリキャッシュし、保存(saveRefreshToken)成功時にキャッシュを無効化する。
 * Cloud Run環境変数へは注入しない(固定バージョンにしない)ための実装。
 */
export class SecretManagerRefreshTokenStore implements RefreshTokenStore {
  private cachedValue: string | null = null;
  private cachedAtMs: number | null = null;

  constructor(private readonly config: SecretManagerRefreshTokenStoreConfig) {}

  async getRefreshToken(): Promise<string | null> {
    const now = this.config.clock.now().getTime();
    if (this.cachedAtMs !== null && now - this.cachedAtMs < CACHE_TTL_MS) {
      return this.cachedValue;
    }

    const name = `projects/${this.config.projectId}/secrets/${this.config.secretName}/versions/latest`;
    try {
      const [version] = await this.config.client.accessSecretVersion({ name });
      const raw = version.payload?.data;
      const value = raw ? Buffer.from(raw).toString('utf8') : '';
      this.cachedValue = value.length > 0 ? value : null;
    } catch {
      // version未作成(未連携)などの場合は未連携として扱う
      this.cachedValue = null;
    }
    this.cachedAtMs = now;
    return this.cachedValue;
  }

  async saveRefreshToken(value: string): Promise<void> {
    if (!value) {
      return;
    }
    const parent = `projects/${this.config.projectId}/secrets/${this.config.secretName}`;
    await this.config.client.addSecretVersion({
      parent,
      payload: { data: Buffer.from(value, 'utf8') },
    });
    this.invalidateCache();
  }

  invalidateCache(): void {
    this.cachedValue = null;
    this.cachedAtMs = null;
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Secret Managerへは一切アクセスしない。 */
export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  public value: string | null = null;
  public saveCallCount = 0;

  async getRefreshToken(): Promise<string | null> {
    return this.value;
  }

  async saveRefreshToken(value: string): Promise<void> {
    if (!value) {
      return;
    }
    this.value = value;
    this.saveCallCount += 1;
  }

  invalidateCache(): void {
    // Fakeはキャッシュを持たないため何もしない
  }
}
