import { supabaseAdmin } from "@/lib/supabase/admin";

const PAGE_SIZE = 1000;

// supabase-js's PostgrestFilterBuilder generics don't unify cleanly between a
// head-count query and a row-returning query of the same shape; `any` here is
// an internal plumbing detail, not part of this module's public surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryBuilder = any;

/** PostgREST caps a single response at 1000 rows. Count the matching set up
 * front, then fire every page request in parallel instead of paging
 * sequentially — at ~87k rows that's the difference between ~90 round trips
 * in series and one round trip's worth of latency.
 * `build` can attach extra filters (eq/ilike/or/etc.) before pagination.
 *
 * Pages are fetched as separate OFFSET/LIMIT queries, so they only line up
 * into a consistent set if the underlying order is stable — without an
 * explicit ORDER BY, Postgres doesn't guarantee the same row order across
 * repeated executions, which silently drops/duplicates rows across page
 * boundaries. Order by `id` to pin it down. */
export async function fetchAllRows<T>(
  table: string,
  columns: string,
  build?: (query: QueryBuilder) => QueryBuilder
): Promise<T[]> {
  let countQuery = supabaseAdmin.from(table).select(columns, { count: "exact", head: true });
  if (build) countQuery = build(countQuery as unknown as QueryBuilder) as typeof countQuery;
  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  const total = count ?? 0;
  if (total === 0) return [];

  const pageCount = Math.ceil(total / PAGE_SIZE);
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) => {
      let query = supabaseAdmin.from(table).select(columns);
      if (build) query = build(query);
      return query.order("id", { ascending: true }).range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1);
    })
  );

  const rows: T[] = [];
  for (const page of pages) {
    if (page.error) throw page.error;
    rows.push(...((page.data ?? []) as T[]));
  }
  return rows;
}
