"use client";

import { useCallback, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  parseVirtualColumnsParam,
  parseVirtualFiltersParam,
  removeColumnFromFilterSet,
  serializeVirtualColumnsParam,
  serializeVirtualFiltersParam,
  virtualColumnIdentity,
  type ActiveVirtualColumn,
  type VirtualColumnType,
  type VirtualFilterSet,
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
  // The entity this page's own custom_data belongs to — derived from `table`
  // so cross-table (source, key) identity (ticket #30) can be resolved
  // without a separate prop threaded through every caller.
  const selfEntity: "company" | "person" = table === "people" ? "person" : "company";

  const activeColumns = parseVirtualColumnsParam(searchParams);
  const activeFilterSet = parseVirtualFiltersParam(searchParams);

  const persist = useCallback(
    (nextColumns: ActiveVirtualColumn[], nextFilterSet: VirtualFilterSet | undefined) => {
      const params = new URLSearchParams(searchParams.toString());
      const c = serializeVirtualColumnsParam(nextColumns);
      if (c) params.set("vc", c);
      else params.delete("vc");
      const f = serializeVirtualFiltersParam(nextFilterSet);
      if (f) params.set("vf", f);
      else params.delete("vf");
      params.delete("page");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      writeVirtualColumnsCache(table, nextColumns, nextFilterSet);
    },
    [router, pathname, searchParams, table]
  );

  // On a bare page load (no `vc` in the URL) restore any still-fresh cached
  // columns so a refresh or a plain revisit within the TTL window doesn't
  // lose them. When `vc` IS present, keep the cache's TTL alive instead so a
  // long working session doesn't expire mid-use.
  useEffect(() => {
    if (searchParams.get("vc")) {
      if (activeColumns.length > 0) writeVirtualColumnsCache(table, activeColumns, activeFilterSet);
      return;
    }
    const cached = readVirtualColumnsCache(table);
    if (cached && cached.columns.length > 0) persist(cached.columns, cached.filters);
    // Only the URL identity should re-trigger this restore/refresh check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, table]);

  const addColumn = useCallback(
    (key: string, type: VirtualColumnType, source?: "company" | "person") => {
      const identity = virtualColumnIdentity(source, key, selfEntity);
      if (activeColumns.some((c) => virtualColumnIdentity(c.source, c.key, selfEntity) === identity)) return;
      persist([...activeColumns, { key, type, ...(source ? { source } : {}) }], activeFilterSet);
    },
    [activeColumns, activeFilterSet, persist, selfEntity]
  );

  const removeColumn = useCallback(
    (key: string, source?: "company" | "person") => {
      const identity = virtualColumnIdentity(source, key, selfEntity);
      persist(
        activeColumns.filter((c) => virtualColumnIdentity(c.source, c.key, selfEntity) !== identity),
        removeColumnFromFilterSet(activeFilterSet, key, source)
      );
    },
    [activeColumns, activeFilterSet, persist, selfEntity]
  );

  /** Replaces the whole grouped filter set at once — the group/condition
   * editing surface (VirtualColumnsBar) owns the immutable updates and hands
   * back the next set (or undefined to clear). Generalizes the pre-#117
   * key-addressed `setFilter` now that the same column can appear in several
   * conditions across groups. */
  const setFilterSet = useCallback(
    (next: VirtualFilterSet | undefined) => {
      persist(activeColumns, next);
    },
    [activeColumns, persist]
  );

  /** Removes every active virtual column and filter at once — used by the
   * manual clear path and by the post-push "remove these temporary columns?"
   * prompt (ticket #40). */
  const clearAll = useCallback(() => {
    persist([], undefined);
  }, [persist]);

  return { activeColumns, activeFilterSet, addColumn, removeColumn, setFilterSet, clearAll };
}
