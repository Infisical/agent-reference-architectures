/**
 * Caches one load per key, as a promise, so concurrent callers share a single call. An entry
 * lives `ttlMs` (reported by the load) from when it resolves, and never expires while pending.
 * A failed load isn't cached, so the next call tries again.
 */
export function createPromiseCache<K, V>(load: (key: K) => Promise<{ value: V; ttlMs: number }>, now = Date.now) {
  const entries = new Map<K, { value: Promise<V>; expiresAt: number }>();

  /**
   * Drops `key` if it still holds `stale`, so callers that all saw the same bad value evict it
   * once and share the next load, rather than each evicting the others' fresh one.
   */
  function invalidate(key: K, stale: Promise<V>): void {
    if (entries.get(key)?.value === stale) entries.delete(key);
  }

  function get(key: K): Promise<V> {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now()) return hit.value;
    const entry = {
      expiresAt: Infinity,
      value: load(key).then(({ value, ttlMs }) => {
        entry.expiresAt = now() + ttlMs;
        return value;
      }),
    };
    entries.set(key, entry);
    entry.value.catch(() => invalidate(key, entry.value));
    return entry.value;
  }

  return { get, invalidate };
}
