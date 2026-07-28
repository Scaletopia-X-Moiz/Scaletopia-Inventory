"use client";

import {
  parseVirtualColumnsParam,
  parseVirtualFiltersParam,
  serializeVirtualColumnsParam,
  serializeVirtualFiltersParam,
  type ActiveVirtualColumn,
  type VirtualColumnFilter,
} from "@/lib/data/virtual-columns";

/** Client-side ephemeral persistence for the active virtual-column set
 * (ticket #40). The `vc`/`vf` URL params stay the live source of truth while
 * a tab is open; this localStorage cache exists only so a refresh, or a bare
 * revisit to `/companies` within ~1 hour, restores the same columns even
 * though a fresh navigation doesn't carry the URL params. Nothing here is
 * ever sent to Supabase — this touches localStorage only. */

const CACHE_KEY_PREFIX = "scaletopia:virtual-columns:v1";
const TTL_MS = 60 * 60 * 1000; // ~1 hour

/** Table this cache entry belongs to — Companies and People each keep an
 * independent active-column set, so the cache key is scoped per table
 * (ticket #41) rather than the single global key ticket #40 shipped with.
 * "companies" keeps the original unscoped-looking key so existing cached
 * entries for /companies aren't silently dropped on deploy. */
export type VirtualColumnsCacheTable = "companies" | "people";

function cacheKey(table: VirtualColumnsCacheTable): string {
  return table === "companies" ? CACHE_KEY_PREFIX : `${CACHE_KEY_PREFIX}:${table}`;
}

interface CachedVirtualColumns {
  columns: ActiveVirtualColumn[];
  filters: VirtualColumnFilter[];
  expiresAt: number;
}

/** Returns the cached columns/filters if present and not expired, or `null`
 * otherwise. Reuses the URL param parsers to validate the cached shape the
 * same way a hand-edited URL would be validated, so a corrupted or
 * schema-stale entry degrades to "no cache" rather than restoring garbage. */
export function readVirtualColumnsCache(table: VirtualColumnsCacheTable): {
  columns: ActiveVirtualColumn[];
  filters: VirtualColumnFilter[];
} | null {
  if (typeof window === "undefined") return null;
  const key = cacheKey(table);
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedVirtualColumns>;
    if (typeof parsed.expiresAt !== "number" || Date.now() >= parsed.expiresAt) {
      window.localStorage.removeItem(key);
      return null;
    }
    const params = new URLSearchParams();
    if (Array.isArray(parsed.columns)) {
      const c = serializeVirtualColumnsParam(parsed.columns as ActiveVirtualColumn[]);
      if (c) params.set("vc", c);
    }
    if (Array.isArray(parsed.filters)) {
      const f = serializeVirtualFiltersParam(parsed.filters as VirtualColumnFilter[]);
      if (f) params.set("vf", f);
    }
    const columns = parseVirtualColumnsParam(params);
    const filters = parseVirtualFiltersParam(params) ?? [];
    if (columns.length === 0) return null;
    return { columns, filters };
  } catch {
    return null;
  }
}

/** Writes the active set with a fresh ~1hr expiry, or clears the entry when
 * there are no active columns left. Best-effort: storage being unavailable
 * (private browsing, quota) never blocks the URL-driven UI. */
export function writeVirtualColumnsCache(
  table: VirtualColumnsCacheTable,
  columns: ActiveVirtualColumn[],
  filters: VirtualColumnFilter[]
): void {
  if (typeof window === "undefined") return;
  const key = cacheKey(table);
  try {
    if (columns.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    const entry: CachedVirtualColumns = { columns, filters, expiresAt: Date.now() + TTL_MS };
    window.localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // ignore
  }
}

export function clearVirtualColumnsCache(table: VirtualColumnsCacheTable): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(cacheKey(table));
  } catch {
    // ignore
  }
}
