/** Process-local cache keyed by JSON-serialized args, with a fixed TTL.
 * Concurrent calls for the same key share the in-flight promise, so a cold
 * cache doesn't trigger redundant duplicate fetches. Failed calls aren't
 * cached, so a transient error doesn't get stuck for the TTL window.
 *
 * Deliberately not `unstable_cache`/`"use cache"`: those require Next's
 * request-scoped runtime, which isn't present when this module's tests call
 * these functions directly under Vitest against the real database.
 *
 * When `cacheKey` is supplied the backing store is stashed on `globalThis`
 * under that key, so it survives `next dev`'s module re-evaluation on HMR /
 * route recompiles (a plain module-scope Map is discarded on every recompile,
 * which is why the same full-table fetch felt "cold" on nearly every local
 * navigation). It also lets two callers that wrap the *same* underlying fetch
 * share one store — e.g. the companies list and its filter facets both bottom
 * out in one cached base fetch instead of two. In production the store lives on
 * the warm instance exactly as a module-scope Map would, so behavior there is
 * unchanged. */
type Store<T> = Map<string, { promise: Promise<T>; expiresAt: number }>;

const globalForCache = globalThis as unknown as {
  __ttlCacheRegistry?: Map<string, Store<unknown>>;
};
const registry = (globalForCache.__ttlCacheRegistry ??= new Map());

function resolveStore<T>(cacheKey?: string): Store<T> {
  if (!cacheKey) return new Map();
  let store = registry.get(cacheKey);
  if (!store) {
    store = new Map();
    registry.set(cacheKey, store);
  }
  return store as Store<T>;
}

/** Drop every entry under `cacheKey` so the next call recomputes from the DB,
 * regardless of the TTL. For callers that write data out-of-band (e.g. a
 * reverify updating one row's email_status directly via Supabase, bypassing
 * this cache entirely) — without this, that write would stay invisible to
 * every cached reader until the TTL naturally expires.
 *
 * Clears the existing Map in place rather than removing it from the registry.
 * `withTtlCache`'s returned closure captures its Map reference once, when the
 * wrapper is created (module load) — `registry.delete(cacheKey)` alone would
 * only affect a *future* closure built from a fresh `resolveStore` call (e.g.
 * after a dev-mode module re-evaluation), while the closure already live in
 * this process keeps its direct reference to the old Map and would never see
 * the deletion. Mutating that same object is what every existing closure
 * actually observes on its next call. */
export function invalidateTtlCache(cacheKey: string): void {
  registry.get(cacheKey)?.clear();
}

export function withTtlCache<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
  ttlMs: number,
  cacheKey?: string
): (...args: Args) => Promise<T> {
  const store = resolveStore<T>(cacheKey);

  return (...args: Args): Promise<T> => {
    const key = JSON.stringify(args);
    const now = Date.now();
    const cached = store.get(key);
    if (cached && cached.expiresAt > now) return cached.promise;

    const promise = fn(...args).catch((error: unknown) => {
      store.delete(key);
      throw error;
    });
    store.set(key, { promise, expiresAt: now + ttlMs });
    return promise;
  };
}
