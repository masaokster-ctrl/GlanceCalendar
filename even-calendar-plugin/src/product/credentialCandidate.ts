// exchange用のaccess/refresh token候補生成専用。installationId.ts(デバイス識別子・低感度)とは異なり、
// credential用途の乱数は質を落としてまで動かし続けるべきではないため、Math.random()等へのフォールバックは
// 一切持たない(crypto.getRandomValuesが使えない環境では例外を投げて呼び出し側に失敗させる)。
const CANDIDATE_BYTES = 32

function hasSecureRandom(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
}

/** 64桁hexのcredential候補を1つ生成する。Backend側のtoken生成(32byte CSPRNG)と同じ形式・強度。 */
export function generateCredentialCandidate(): string {
  if (!hasSecureRandom()) {
    throw new Error('secure random number generator unavailable')
  }
  const bytes = new Uint8Array(CANDIDATE_BYTES)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface CredentialCandidatePair {
  accessToken: string
  refreshToken: string
}

/** access/refresh用の2つの候補をまとめて生成する。 */
export function generateCredentialCandidatePair(): CredentialCandidatePair {
  return { accessToken: generateCredentialCandidate(), refreshToken: generateCredentialCandidate() }
}
