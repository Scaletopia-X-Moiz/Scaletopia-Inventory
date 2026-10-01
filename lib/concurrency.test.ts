import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "@/lib/concurrency";

/** The bound is the point: a 25,000-id lookup chunks into ~125 queries, and
 * `Promise.all` over all of them is how this project meets its pool
 * timeouts. */

describe("mapWithConcurrency", () => {
  it("keeps results in input order whatever order they settle in", async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms / 10));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 6, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return null;
    });
    expect(peak).toBe(6);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 6, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
  });

  it("rejects on the first failure and stops starting new work", async () => {
    let started = 0;
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (n) => {
        started++;
        if (n === 2) throw new Error("boom");
        return n;
      })
    ).rejects.toThrow("boom");
    // Serial pool: it should not have worked its way to the end regardless.
    expect(started).toBeLessThan(6);
  });
});
