import type { GoogleOAuthConfig } from '../auth/googleOAuthClient.js';
import type { CalendarService } from '../calendar/calendarService.js';
import type { GoogleCredentialRepository } from './productGoogleCredentialRepository.js';
import { logSafeEvent } from '../security/safeLogger.js';

export interface CalendarServiceResolverDeps {
  productOAuthConfig: GoogleOAuthConfig | null;
  productCredentialRepo: GoogleCredentialRepository;
  devOAuthConfig: GoogleOAuthConfig;
  getDevRefreshToken: () => Promise<string | null>;
  buildCalendarService: (oauthConfig: GoogleOAuthConfig, refreshToken: string) => CalendarService;
}

/**
 * product user(userId指定あり)のGoogle refresh tokenは、発行時と同じproduct OAuth client
 * (PRODUCT_GOOGLE_OAUTH_CLIENT_ID/SECRET)でのみrefreshできる。devのoauthConfigを使うとGoogleの
 * token endpointがrefresh tokenの発行元clientと不一致としてinvalid_grant/invalid_client相当の
 * エラーで拒否する(RFC 6749: refresh tokenは発行元clientに紐付く)。dev用の既存経路(userId未指定)は
 * 従来通りdevOAuthConfig+refreshTokenStoreを使い、一切変更しない。
 */
export function createCalendarServiceResolver(deps: CalendarServiceResolverDeps) {
  return async function resolveCalendarService(userId?: string | null): Promise<CalendarService | null> {
    if (userId) {
      if (!deps.productOAuthConfig) {
        return null;
      }
      let credential: { refreshToken: string; grantedScopes: string[] } | null;
      try {
        credential = await deps.productCredentialRepo.getForUser(userId);
      } catch {
        // KMS decrypt等の失敗を平文fallbackせず安全に扱う。呼び出し元は既存の
        // 「calendarService === null」ハンドリング(403 Forbidden)にそのまま乗る。
        logSafeEvent({
          event: 'product_calendar_credential_lookup_failed',
          level: 'error',
          sanitizedErrorCode: 'product_google_credential_decrypt_failed',
        });
        return null;
      }
      if (!credential) {
        return null;
      }
      return deps.buildCalendarService(deps.productOAuthConfig, credential.refreshToken);
    }

    const refreshToken = await deps.getDevRefreshToken();
    if (!refreshToken) {
      return null;
    }
    return deps.buildCalendarService(deps.devOAuthConfig, refreshToken);
  };
}
