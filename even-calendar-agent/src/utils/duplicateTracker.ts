const WINDOW_MS = 30_000;
const MAX_TRACKED_FINGERPRINTS = 1000;

interface Entry {
  timestamps: number[];
}

const store = new Map<string, Entry>();

function pruneExpired(now: number): void {
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < WINDOW_MS);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}

function enforceCapacity(): void {
  if (store.size <= MAX_TRACKED_FINGERPRINTS) {
    return;
  }

  const sorted = [...store.entries()].sort((a, b) => (a[1].timestamps[0] ?? 0) - (b[1].timestamps[0] ?? 0));
  let excess = store.size - MAX_TRACKED_FINGERPRINTS;
  for (const [key] of sorted) {
    if (excess <= 0) {
      break;
    }
    store.delete(key);
    excess -= 1;
  }
}

/**
 * 同一Cloud Runインスタンス内・過去30秒以内に同じfingerprintが届いた回数を記録して返す（初回は1）。
 * インスタンス間では共有されない、調査用の単純なインメモリカウンターであり、期限切れの
 * エントリと上限件数超過分は都度削除してメモリが無制限に増えないようにする。
 */
export function recordAndCountDuplicates(fingerprint: string, now: number = Date.now()): number {
  pruneExpired(now);

  let entry = store.get(fingerprint);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(fingerprint, entry);
  }

  entry.timestamps = entry.timestamps.filter((t) => now - t < WINDOW_MS);
  entry.timestamps.push(now);

  enforceCapacity();

  return entry.timestamps.length;
}

export function resetDuplicateTrackerForTests(): void {
  store.clear();
}
