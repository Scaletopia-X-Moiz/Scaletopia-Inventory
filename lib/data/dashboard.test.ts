import { describe, expect, it } from "vitest";
import { getDashboard } from "@/lib/data/dashboard";

describe("getDashboard", () => {
  it("returns all-time totals and breakdowns with no range", async () => {
    const dashboard = await getDashboard();

    expect(dashboard.totalCompanies).toBeGreaterThan(0);
    expect(dashboard.totalPeople).toBeGreaterThan(0);
    expect(dashboard.niches.length).toBeGreaterThan(0);
    expect(dashboard.recentCompanies.length).toBeGreaterThan(0);
  }, 30000);

  it("a future `from` bound empties breakdowns, recent companies, and totals", async () => {
    const futureYear = new Date().getFullYear() + 1;
    const future = await getDashboard({ from: `${futureYear}-01-01T00:00:00.000Z` });

    expect(future.recentCompanies).toHaveLength(0);
    expect(future.niches).toHaveLength(0);
    expect(future.sources).toHaveLength(0);

    // totals are scoped to the range, so a future-only window has nothing in it.
    expect(future.totalCompanies).toBe(0);
    expect(future.totalPeople).toBe(0);
  }, 30000);

  it("narrowing the range never returns higher totals than all-time", async () => {
    const allTime = await getDashboard();
    const sample = allTime.recentCompanies[0];
    if (!sample?.createdAt) return;

    const narrowed = await getDashboard({ from: sample.createdAt });
    expect(narrowed.totalCompanies).toBeLessThanOrEqual(allTime.totalCompanies);
    expect(narrowed.totalPeople).toBeLessThanOrEqual(allTime.totalPeople);
  }, 30000);

  it("narrowing the range never returns more recent companies than all-time", async () => {
    const allTime = await getDashboard();
    const sample = allTime.recentCompanies[0];
    if (!sample?.createdAt) return;

    const narrowed = await getDashboard({ from: sample.createdAt });
    for (const company of narrowed.recentCompanies) {
      expect(new Date(company.createdAt ?? 0).getTime()).toBeGreaterThanOrEqual(
        new Date(sample.createdAt).getTime()
      );
    }
  }, 30000);
});
