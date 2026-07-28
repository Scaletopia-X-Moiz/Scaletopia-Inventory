"use client";

import { useCallback, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  parseVirtualColumnsParam,
  parseVirtualFiltersParam,
  serializeVirtualColumnsParam,
  serializeVirtualFiltersParam,
  type ActiveVirtualColumn,
  type VirtualColumnFilter,
  type VirtualColumnType,
} from "@/lib/data/virtual-columns";
import {
  readVirtualColumnsCache,
  writeVirtualColumnsCache,
  type VirtualColumnsCacheTable,
} from "@/lib/data/virtual-columns-cache";

/** Single source of truth for the active virtual-column set: the `vc`/`vf`
 * URL params, mirrored into a ~1hr client cache so a refresh (or a bare
 * revisit to the page) within the window restores the same columns (ticket
 * #40). Shared by VirtualColumnsBar (the editing UI) and *ResultsClient (the
 * post-push "remove these?" prompt) so both read and write the same state
 * instead of duplicating the URL-sync logic. `table` scopes the ~1hr cache
 * (ticket #41) so Companies and People keep independent active-column sets
 * instead of clobbering each other's cache entry. */
export function useVirtualColumnsState(table: VirtualColumnsCacheTable = "companies") {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeColumns = parseVirtualColumnsParam(searchParams);
  const activeFilters = parseVirtualFiltersParam(searchParams) ?? [];

  const persist = useCallback(
    (nextColumns: ActiveVirtualColumn[], nextFilters: VirtualColumnFilter[]) => {
      const params = new URLSearchParams(searchParams.toString());
      const c = serializeVirtualColumnsParam(nextColumns);
      if (c) params.set("vc", c);
      else params.delete("vc");
      const f = serializeVirtualFiltersParam(nextFilters);
      if (f) params.set("vf", f);
      else params.delete("vf");
      params.delete("page");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      writeVirtualColumnsCache(table, nextColumns, nextFilters);
    },
    [router, pathname, searchParams, table]
  );

  // On a bare page load (no `vc` in the URL) restore any still-fresh cached
  // columns so a refresh or a plain revisit within the TTL window doesn't
  // lose them. When `vc` IS present, keep the cache's TTL alive instead so a
  // long working session doesn't expire mid-use.
  useEffect(() => {
    if (searchParams.get("vc")) {
      if (activeColumns.length > 0) writeVirtualColumnsCache(table, activeColumns, activeFilters);
      return;
    }
    const cached = readVirtualColumnsCache(table);
    if (cached && cached.columns.length > 0) persist(cached.columns, cached.filters);
    // Only the URL identity should re-trigger this restore/refresh check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, table]);

  const addColumn = useCallback(
    (key: string, type: VirtualColumnType) => {
      if (activeColumns.some((c) => c.key === key)) return;
      persist([...activeColumns, { key, type }], activeFilters);
    },
    [activeColumns, activeFilters, persist]
  );

  const removeColumn = useCallback(
    (key: string) => {
      persist(
        activeColumns.filter((c) => c.key !== key),
        activeFilters.filter((f) => f.key !== key)
      );
    },
    [activeColumns, activeFilters, persist]
  );

  const setFilter = useCallback(
    (key: string, filter: VirtualColumnFilter | null) => {
      const rest = activeFilters.filter((f) => f.key !== key);
      persist(activeColumns, filter ? [...rest, filter] : rest);
    },
    [activeColumns, activeFilters, persist]
  );

  /** Removes every active virtual column and filter at once — used by the
   * manual clear path and by the post-push "remove these temporary columns?"
   * prompt (ticket #40). */
  const clearAll = useCallback(() => {
    persist([], []);
  }, [persist]);

  return { activeColumns, activeFilters, addColumn, removeColumn, setFilter, clearAll };
}
