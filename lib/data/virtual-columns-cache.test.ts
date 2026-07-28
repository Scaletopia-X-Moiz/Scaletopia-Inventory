import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveVirtualColumn, VirtualColumnFilter } from "@/lib/data/virtual-columns";

/** The cache module reads `typeof window` to no-op server-side, so tests
 * stand up a minimal in-memory localStorage on `globalThis.window` — the
 * vitest config runs in the "node" environment (no jsdom), matching how the
 * rest of the client-only test files in this repo handle browser globals. */
function installFakeLocalStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  vi.stubGlobal("window", { localStorage });
  return localStorage;
}

const columns: ActiveVirtualColumn[] = [{ key: "lead_score", type: "number" }];
const filters: VirtualColumnFilter[] = [
  { key: "lead_score", type: "number", operator: "gt", value: 50 },
];

describe("virtual-columns-cache", () => {
  beforeEach(() => {
    installFakeLocalStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns null when nothing is cached", async () => {
    const { readVirtualColumnsCache } = await import("@/lib/data/virtual-columns-cache");
    expect(readVirtualColumnsCache("companies")).toBeNull();
  });

  it("round-trips a written entry", async () => {
    const { readVirtualColumnsCache, writeVirtualColumnsCache } = await import(
      "@/lib/data/virtual-columns-cache"
    );
    writeVirtualColumnsCache("companies", columns, filters);
    expect(readVirtualColumnsCache("companies")).toEqual({ columns, filters });
  });

  it("expires after the TTL window", async () => {
    const { readVirtualColumnsCache, writeVirtualColumnsCache } = await import(
      "@/lib/data/virtual-columns-cache"
    );
    writeVirtualColumnsCache("companies", columns, filters);
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(readVirtualColumnsCache("companies")).toBeNull();
  });

  it("survives a refresh within the TTL window", async () => {
    const { readVirtualColumnsCache, writeVirtualColumnsCache } = await import(
      "@/lib/data/virtual-columns-cache"
    );
    writeVirtualColumnsCache("companies", columns, filters);
    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(readVirtualColumnsCache("companies")).toEqual({ columns, filters });
  });

  it("clears the entry when written with an empty column set", async () => {
    const { readVirtualColumnsCache, writeVirtualColumnsCache } = await import(
      "@/lib/data/virtual-columns-cache"
    );
    writeVirtualColumnsCache("companies", columns, filters);
    writeVirtualColumnsCache("companies", [], []);
    expect(readVirtualColumnsCache("companies")).toBeNull();
  });

  it("clearVirtualColumnsCache removes the entry", async () => {
    const { readVirtualColumnsCache, writeVirtualColumnsCache, clearVirtualColumnsCache } =
      await import("@/lib/data/virtual-columns-cache");
    writeVirtualColumnsCache("companies", columns, filters);
    clearVirtualColumnsCache("companies");
    expect(readVirtualColumnsCache("companies")).toBeNull();
  });

  it("drops a corrupted entry instead of throwing", async () => {
    const localStorage = installFakeLocalStorage();
    localStorage.setItem("scaletopia:virtual-columns:v1", "not json");
    const { readVirtualColumnsCache } = await import("@/lib/data/virtual-columns-cache");
    expect(readVirtualColumnsCache("companies")).toBeNull();
  });

  it("keeps companies and people caches independent", async () => {
    const { readVirtualColumnsCache, writeVirtualColumnsCache } = await import(
      "@/lib/data/virtual-columns-cache"
    );
    writeVirtualColumnsCache("companies", columns, filters);
    expect(readVirtualColumnsCache("people")).toBeNull();
    expect(readVirtualColumnsCache("companies")).toEqual({ columns, filters });
  });
});
