/**
 * バックエンドの GET /health を確認する。Authorizationは付与せず、音声も送信しない。
 * 失敗しても例外を投げず false を返す(起動は継続する)。
 */
export async function checkBackendHealth(baseUrl: string, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${baseUrl}/health`, { method: 'GET', signal: controller.signal })
    if (!res.ok) {
      return false
    }
    const data: unknown = await res.json().catch(() => null)
    return isHealthOk(data)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function isHealthOk(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>).status === 'ok'
}
