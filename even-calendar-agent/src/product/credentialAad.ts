export const CREDENTIAL_AAD_VERSION = 'v1';

/**
 * Google refresh tokenのKMS暗号化に使うAdditional Authenticated Data。userIdを含めることで、
 * 他ユーザーのciphertextを誤って(あるいは攻撃的に)このユーザーのAADで復号できないようにする
 * (KMSはAADが一致しない限りdecryptを拒否する)。
 */
export function computeCredentialAad(userId: string): string {
  return `calendar-with-gemini|google-refresh-token|${CREDENTIAL_AAD_VERSION}|${userId}`;
}
