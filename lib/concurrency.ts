/** Runs `task` over `items` with at most `limit` in flight at once, returning
 * the results in input order.
 *
 * `Promise.all(items.map(task))` is the thing this exists to replace. It is
 * fine for a handful of items and quietly dangerous for a list whose length
 * is a function of user input: a 25,000-id lookup chunked at 200 fans out to
 * ~125 simultaneous Supabase queries, which on this project means pool
 * timeouts rather than speed. A bounded pool keeps the latency win (the
 * chunks still overlap) without letting the fan-out scale with the request.
 *
 * Rejection behaves like `Promise.all`: the first failure rejects, and tasks
 * already in flight are not cancelled (nothing here can cancel a query) but
 * no further ones are started.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  // `width` workers pulling from one shared cursor, rather than fixed slices:
  // chunk durations vary wildly (a chunk whose ids are all missing returns
  // instantly), and a slice-per-worker split would leave the pool idle behind
  // whichever slice drew the slow rows.
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
