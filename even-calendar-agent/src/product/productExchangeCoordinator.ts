import type { Firestore, Transaction } from '@google-cloud/firestore';
import { normalizeDate, normalizeNullableDate } from '../firestore/firestoreDates.js';
import type { ProductPairingSessionDoc, ProductInstallationDoc, PluginSessionDoc, ProductDeviceRefreshTokenDoc } from '../firestore/models.js';

const DEVICE_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEVICE_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_SCOPES = ['audio:analyze', 'calendar:create', 'calendar:status', 'calendar:read', 'calendar:update', 'calendar:delete'];

export interface ProductExchangeParams {
  pairingId: string;
  installationId: string;
  installationIdHash: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  now: Date;
}

export type ProductExchangeResult =
  | { kind: 'registered'; accessTokenExpiresInSeconds: number; refreshTokenExpiresAt: Date; scopes: string[]; userId: string }
  | { kind: 'not_found' }
  | { kind: 'installation_mismatch' }
  | { kind: 'not_approved' }
  | { kind: 'hash_mismatch' }
  | { kind: 'installation_revoked' }
  | { kind: 'internal_inconsistency' };

/**
 * client-generated credential方式のexchangeをatomicに確定する。
 *
 * Plugin側が既にaccess/refresh token候補(生値)をCSPRNGで生成しbridge storageへ永続化済みという
 * 前提のもと、Backendは「そのhashペアをこのpairingの正としてFirestoreへ一度だけ登録する」だけの
 * 役割に限定される。同じhashペアの再送は冪等replay(exchangedAt以外は書き換えない)、異なるhashペアは
 * hash_mismatchとして拒否する。これにより「Backend側が新しい生tokenを都度発行し直す」ことによる
 * 並行exchange時のcredential置換競合が構造的に発生しない。
 *
 * pairing docの確定・pluginSessions(access token)の作成・productDeviceRefreshTokens(refresh token)の
 * 作成・productInstallationsのuserId紐付け/tokenVersion取得を単一のFirestore transactionで行う。
 * 対応するRepositoryの公開メソッドを個別に呼ぶだけでは、この4コレクション横断のatomic性を保証できない
 * ため、専用のcoordinatorとして切り出している。
 */
export interface ProductExchangeCoordinator {
  exchange(params: ProductExchangeParams): Promise<ProductExchangeResult>;
}

function normalizePairingDoc(doc: ProductPairingSessionDoc): ProductPairingSessionDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    expiresAt: normalizeDate(doc.expiresAt),
    approvedAt: normalizeNullableDate(doc.approvedAt),
    exchangedAt: normalizeNullableDate(doc.exchangedAt),
  };
}

function normalizeInstallationDoc(doc: ProductInstallationDoc): ProductInstallationDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    pairedAt: normalizeNullableDate(doc.pairedAt),
    lastSeenAt: normalizeNullableDate(doc.lastSeenAt),
    revokedAt: normalizeNullableDate(doc.revokedAt),
  };
}

function normalizeSessionDoc(doc: PluginSessionDoc): PluginSessionDoc {
  return { ...doc, createdAt: normalizeDate(doc.createdAt), expiresAt: normalizeDate(doc.expiresAt), revokedAt: normalizeNullableDate(doc.revokedAt) };
}

function normalizeRefreshDoc(doc: ProductDeviceRefreshTokenDoc): ProductDeviceRefreshTokenDoc {
  return {
    ...doc,
    createdAt: normalizeDate(doc.createdAt),
    expiresAt: normalizeDate(doc.expiresAt),
    rotatedAt: normalizeNullableDate(doc.rotatedAt),
    revokedAt: normalizeNullableDate(doc.revokedAt),
  };
}

const PAIRING_COLLECTION = 'productPairingSessions';
const INSTALLATION_COLLECTION = 'productInstallations';
const SESSION_COLLECTION = 'pluginSessions';
const REFRESH_TOKEN_COLLECTION = 'productDeviceRefreshTokens';

export class FirestoreProductExchangeCoordinator implements ProductExchangeCoordinator {
  constructor(private readonly firestore: Firestore) {}

  async exchange(params: ProductExchangeParams): Promise<ProductExchangeResult> {
    const pairingRef = this.firestore.collection(PAIRING_COLLECTION).doc(params.pairingId);
    const installationRef = this.firestore.collection(INSTALLATION_COLLECTION).doc(params.installationId);
    const accessRef = this.firestore.collection(SESSION_COLLECTION).doc(params.accessTokenHash);
    const refreshRef = this.firestore.collection(REFRESH_TOKEN_COLLECTION).doc(params.refreshTokenHash);

    return this.firestore.runTransaction(async (tx: Transaction) => {
      // ---- 読み取りは全て先に行う(Firestore transactionの制約) ----
      const pairingSnap = await tx.get(pairingRef);
      if (!pairingSnap.exists) return { kind: 'not_found' } as const;
      const pairing = normalizePairingDoc(pairingSnap.data() as ProductPairingSessionDoc);
      if (pairing.installationIdHash !== params.installationIdHash) return { kind: 'installation_mismatch' } as const;

      let isReplay = false;
      if (pairing.status === 'approved') {
        // 初回
      } else if (pairing.status === 'exchanged') {
        if (pairing.exchangeAccessTokenHash === params.accessTokenHash && pairing.exchangeRefreshTokenHash === params.refreshTokenHash) {
          isReplay = true;
        } else {
          return { kind: 'hash_mismatch' } as const;
        }
      } else {
        return { kind: 'not_approved' } as const;
      }

      const installationSnap = await tx.get(installationRef);
      const installation = installationSnap.exists
        ? normalizeInstallationDoc(installationSnap.data() as ProductInstallationDoc)
        : ({
            installationId: params.installationId,
            userId: null,
            status: 'active',
            createdAt: params.now,
            pairedAt: null,
            lastSeenAt: params.now,
            revokedAt: null,
            tokenVersion: 1,
            appVersion: null,
            sdkVersion: null,
          } satisfies ProductInstallationDoc);

      if (isReplay) {
        if (pairing.userId === null) return { kind: 'internal_inconsistency' } as const;
        const accessSnap = await tx.get(accessRef);
        const refreshSnap = await tx.get(refreshRef);
        if (!accessSnap.exists || !refreshSnap.exists) return { kind: 'internal_inconsistency' } as const;
        const accessDoc = normalizeSessionDoc(accessSnap.data() as PluginSessionDoc);
        const refreshDoc = normalizeRefreshDoc(refreshSnap.data() as ProductDeviceRefreshTokenDoc);

        const consistent =
          accessDoc.installId === params.installationId &&
          accessDoc.userId === pairing.userId &&
          accessDoc.tokenVersion === installation.tokenVersion &&
          accessDoc.revokedAt === null &&
          accessDoc.expiresAt.getTime() > params.now.getTime() &&
          refreshDoc.installationId === params.installationId &&
          refreshDoc.userId === pairing.userId &&
          refreshDoc.revokedAt === null &&
          refreshDoc.rotatedAt === null &&
          refreshDoc.expiresAt.getTime() > params.now.getTime();
        if (!consistent) return { kind: 'internal_inconsistency' } as const;

        return {
          kind: 'registered',
          accessTokenExpiresInSeconds: Math.max(0, Math.floor((accessDoc.expiresAt.getTime() - params.now.getTime()) / 1000)),
          refreshTokenExpiresAt: refreshDoc.expiresAt,
          scopes: accessDoc.scope,
          userId: pairing.userId,
        } as const;
      }

      // ---- ここから初回のみ ----
      if (installation.status === 'revoked') {
        // revoke済みのinstallationへ新しいdevice credentialを発行して再有効化することは絶対にしない。
        tx.set(pairingRef, { status: 'failed', sanitizedErrorCode: 'installation_revoked' }, { merge: true });
        return { kind: 'installation_revoked' } as const;
      }

      const userId = pairing.userId;
      if (!userId) return { kind: 'not_approved' } as const;

      if (!installationSnap.exists) {
        tx.set(installationRef, installation);
      }
      if (installation.userId !== userId) {
        tx.set(installationRef, { userId, pairedAt: params.now, lastSeenAt: params.now }, { merge: true });
      }

      const accessExpiresAt = new Date(params.now.getTime() + DEVICE_ACCESS_TOKEN_TTL_MS);
      const refreshExpiresAt = new Date(params.now.getTime() + DEVICE_REFRESH_TOKEN_TTL_MS);

      tx.set(
        pairingRef,
        {
          status: 'exchanged',
          exchangedAt: params.now,
          exchangeAccessTokenHash: params.accessTokenHash,
          exchangeRefreshTokenHash: params.refreshTokenHash,
        },
        { merge: true },
      );

      const accessDoc: PluginSessionDoc = {
        tokenHash: params.accessTokenHash,
        installId: params.installationId,
        scope: DEVICE_SCOPES,
        createdAt: params.now,
        expiresAt: accessExpiresAt,
        revokedAt: null,
        tokenType: 'device',
        userId,
        tokenVersion: installation.tokenVersion,
      };
      tx.set(accessRef, accessDoc);

      const refreshDoc: ProductDeviceRefreshTokenDoc = {
        refreshTokenHash: params.refreshTokenHash,
        installationId: params.installationId,
        userId,
        familyId: params.refreshTokenHash,
        generation: 1,
        createdAt: params.now,
        expiresAt: refreshExpiresAt,
        rotatedAt: null,
        revokedAt: null,
        replacedByHash: null,
        reuseDetectedAt: null,
      };
      tx.set(refreshRef, refreshDoc);

      return {
        kind: 'registered',
        accessTokenExpiresInSeconds: DEVICE_ACCESS_TOKEN_TTL_MS / 1000,
        refreshTokenExpiresAt: refreshExpiresAt,
        scopes: DEVICE_SCOPES,
        userId,
      } as const;
    });
  }
}

/** テスト・ローカル疎通確認用のインメモリ実装。実Firestoreへは一切アクセスしない。
 *  JSはシングルスレッドのため、このクラス自身は「並行transactionの競合」を再現しないが、
 *  論理(初回登録/冪等replay/hash_mismatch/revoked installation拒否/整合性チェック)の検証には使える。 */
export class InMemoryProductExchangeCoordinator implements ProductExchangeCoordinator {
  constructor(
    private readonly pairings: Map<string, ProductPairingSessionDoc> = new Map(),
    private readonly installations: Map<string, ProductInstallationDoc> = new Map(),
    private readonly sessions: Map<string, PluginSessionDoc> = new Map(),
    private readonly refreshTokens: Map<string, ProductDeviceRefreshTokenDoc> = new Map(),
  ) {}

  async exchange(params: ProductExchangeParams): Promise<ProductExchangeResult> {
    const pairing = this.pairings.get(params.pairingId);
    if (!pairing) return { kind: 'not_found' };
    if (pairing.installationIdHash !== params.installationIdHash) return { kind: 'installation_mismatch' };

    let isReplay = false;
    if (pairing.status === 'approved') {
      // 初回
    } else if (pairing.status === 'exchanged') {
      if (pairing.exchangeAccessTokenHash === params.accessTokenHash && pairing.exchangeRefreshTokenHash === params.refreshTokenHash) {
        isReplay = true;
      } else {
        return { kind: 'hash_mismatch' };
      }
    } else {
      return { kind: 'not_approved' };
    }

    let installation = this.installations.get(params.installationId);
    if (!installation) {
      installation = {
        installationId: params.installationId,
        userId: null,
        status: 'active',
        createdAt: params.now,
        pairedAt: null,
        lastSeenAt: params.now,
        revokedAt: null,
        tokenVersion: 1,
        appVersion: null,
        sdkVersion: null,
      };
    }

    if (isReplay) {
      if (pairing.userId === null) return { kind: 'internal_inconsistency' };
      const accessDoc = this.sessions.get(params.accessTokenHash);
      const refreshDoc = this.refreshTokens.get(params.refreshTokenHash);
      if (!accessDoc || !refreshDoc) return { kind: 'internal_inconsistency' };
      const consistent =
        accessDoc.installId === params.installationId &&
        accessDoc.userId === pairing.userId &&
        accessDoc.tokenVersion === installation.tokenVersion &&
        accessDoc.revokedAt === null &&
        accessDoc.expiresAt.getTime() > params.now.getTime() &&
        refreshDoc.installationId === params.installationId &&
        refreshDoc.userId === pairing.userId &&
        refreshDoc.revokedAt === null &&
        refreshDoc.rotatedAt === null &&
        refreshDoc.expiresAt.getTime() > params.now.getTime();
      if (!consistent) return { kind: 'internal_inconsistency' };
      return {
        kind: 'registered',
        accessTokenExpiresInSeconds: Math.max(0, Math.floor((accessDoc.expiresAt.getTime() - params.now.getTime()) / 1000)),
        refreshTokenExpiresAt: refreshDoc.expiresAt,
        scopes: accessDoc.scope,
        userId: pairing.userId,
      };
    }

    if (installation.status === 'revoked') {
      this.pairings.set(params.pairingId, { ...pairing, status: 'failed', sanitizedErrorCode: 'installation_revoked' });
      return { kind: 'installation_revoked' };
    }

    const userId = pairing.userId;
    if (!userId) return { kind: 'not_approved' };

    if (installation.userId !== userId) {
      installation = { ...installation, userId, pairedAt: params.now, lastSeenAt: params.now };
    }
    this.installations.set(params.installationId, installation);

    const accessExpiresAt = new Date(params.now.getTime() + DEVICE_ACCESS_TOKEN_TTL_MS);
    const refreshExpiresAt = new Date(params.now.getTime() + DEVICE_REFRESH_TOKEN_TTL_MS);

    this.pairings.set(params.pairingId, {
      ...pairing,
      status: 'exchanged',
      exchangedAt: params.now,
      exchangeAccessTokenHash: params.accessTokenHash,
      exchangeRefreshTokenHash: params.refreshTokenHash,
    });

    this.sessions.set(params.accessTokenHash, {
      tokenHash: params.accessTokenHash,
      installId: params.installationId,
      scope: DEVICE_SCOPES,
      createdAt: params.now,
      expiresAt: accessExpiresAt,
      revokedAt: null,
      tokenType: 'device',
      userId,
      tokenVersion: installation.tokenVersion,
    });

    this.refreshTokens.set(params.refreshTokenHash, {
      refreshTokenHash: params.refreshTokenHash,
      installationId: params.installationId,
      userId,
      familyId: params.refreshTokenHash,
      generation: 1,
      createdAt: params.now,
      expiresAt: refreshExpiresAt,
      rotatedAt: null,
      revokedAt: null,
      replacedByHash: null,
      reuseDetectedAt: null,
    });

    return {
      kind: 'registered',
      accessTokenExpiresInSeconds: DEVICE_ACCESS_TOKEN_TTL_MS / 1000,
      refreshTokenExpiresAt: refreshExpiresAt,
      scopes: DEVICE_SCOPES,
      userId,
    };
  }
}
