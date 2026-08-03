import { describe, it, expect } from "vitest";
import { getCompanies } from "@/lib/data/companies";

describe("timing probe", () => {
  it("is_not_empty on a field matching ~11k rows", async () => {
    const t0 = Date.now();
    const result = await getCompanies(
      { virtualFilters: [{ key: "categories", type: "text" as const, operator: "is_not_empty" as const }] },
      1,
      1
    );
    console.log("ms", Date.now() - t0, "total", result.total);
    expect(result.total).toBeGreaterThan(0);
  }, 55000);
});
