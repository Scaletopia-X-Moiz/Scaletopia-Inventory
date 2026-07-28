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

const CACHE_KEY = "scaletopia:virtual-columns:v1";
const TTL_MS = 60 * 60 * 1000; // ~1 hour

interface CachedVirtualColumns {
  columns: ActiveVirtualColumn[];
  filters: VirtualColumnFilter[];
  expiresAt: number;
}

/** Returns the cached columns/filters if present and not expired, or `null`
 * otherwise. Reuses the URL param parsers to validate the cached shape the
 * same way a hand-edited URL would be validated, so a corrupted or
 * schema-stale entry degrades to "no cache" rather than restoring garbage. */
export function readVirtualColumnsCache(): {
  columns: ActiveVirtualColumn[];
  filters: VirtualColumnFilter[];
} | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedVirtualColumns>;
    if (typeof parsed.expiresAt !== "number" || Date.now() >= parsed.expiresAt) {
      window.localStorage.removeItem(CACHE_KEY);
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
  columns: ActiveVirtualColumn[],
  filters: VirtualColumnFilter[]
): void {
  if (typeof window === "undefined") return;
  try {
    if (columns.length === 0) {
      window.localStorage.removeItem(CACHE_KEY);
      return;
    }
    const entry: CachedVirtualColumns = { columns, filters, expiresAt: Date.now() + TTL_MS };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // ignore
  }
}

export function clearVirtualColumnsCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}
