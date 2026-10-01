import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonListFilters } from "@/lib/data/people";

/** What a filtered refresh is allowed to refuse, and on what grounds.
 *
 * Two caps that were previously one, and the one they were measured the
 * wrong population:
 *
 *  - the SCAN cap (MAX_FILTER_SCAN) is ours — resolving the matched set is
 *    itself expensive, and the preview re-runs on every click;
 *  - the COST cap (MAX_FILTERED_PEOPLE) is GHL's, and only people with a
 *    `platform_pushes` row cost anything. Capping on "people the filter
 *    matches" refused a 12-call refresh on the grounds that each of 30,000
 *    matched people costs a call per sub-account, which is false for the
 *    29,988 that have no GHL contact at all.
 *
 * Mocked at the data layer because both caps are decisions, not queries.
 */

const tryCountFilteredPeople = vi.fn<(f: PersonListFilters) => Promise<number | null>>();
const getAllFilteredPeople = vi.fn<(f: PersonListFilters) => Promise<{ id: string }[]>>();
const getClientsForPeople = vi.fn();
const countPushedPeople = vi.fn();

vi.mock("@/lib/data/people", () => ({
  tryCountFilteredPeople: (f: PersonListFilters) => tryCountFilteredPeople(f),
  getAllFilteredPeople: (f: PersonListFilters) => getAllFilteredPeople(f),
}));
vi.mock("@/lib/data/ghl-activity", () => ({
  getClientsForPeople: (ids: string[]) => getClientsForPeople(ids),
  countPushedPeople: (clientId: string) => countPushedPeople(clientId),
}));

const { planActivityRefresh } = await import("@/lib/ghl/refresh-activity-plan");
const { MAX_FILTERED_PEOPLE, MAX_FILTER_SCAN } = await import("@/lib/ghl/activity-scope");

/** A filter snapshot that actually narrows something, so the plan takes the
 * filtered path rather than the whole-sub-account one. */
const FILTERS = { search: "acme" } as PersonListFilters;

function people(n: number, prefix = "p"): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  tryCountFilteredPeople.mockResolvedValue(null);
  getAllFilteredPeople.mockResolvedValue([]);
  getClientsForPeople.mockResolvedValue([]);
});

describe("the scan cap", () => {
  it("refuses an enormous filter from the COUNT, without materializing it", async () => {
    tryCountFilteredPeople.mockResolvedValue(MAX_FILTER_SCAN + 1);

    const planned = await planActivityRefresh({ scope: { kind: "filters" }, filters: FILTERS, clientIds: null });

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.code).toBe("too_many_filtered");
    // The whole point: 80,000 rows were not fetched in order to reject them.
    expect(getAllFilteredPeople).not.toHaveBeenCalled();
    // And the refusal does not claim those people would cost API calls.
    expect(planned.error).not.toContain("GHL API call per sub-account");
    expect(planned.error).toContain("too slow");
  });

  it("still judges a path that has no cheap count, after resolving it", async () => {
    // virtualFilters / pushJobId / lastActivity resolve as id sets, so
    // tryCountFilteredPeople returns null and the guard lands one step later
    // — still before the platform_pushes fan-out.
    tryCountFilteredPeople.mockResolvedValue(null);
    getAllFilteredPeople.mockResolvedValue(people(MAX_FILTER_SCAN + 1));

    const planned = await planActivityRefresh({ scope: { kind: "filters" }, filters: FILTERS, clientIds: null });

    expect(planned.ok).toBe(false);
    expect(getClientsForPeople).not.toHaveBeenCalled();
  });
});

describe("the cost cap", () => {
  it("does not refuse a huge filter that barely touches GHL", async () => {
    // 30,000 matched, 12 ever pushed: the real cost is 12 calls.
    tryCountFilteredPeople.mockResolvedValue(30_000);
    getAllFilteredPeople.mockResolvedValue(people(30_000));
    getClientsForPeople.mockResolvedValue([
      { clientId: "c1", personCount: 12, personIds: people(12).map((p) => p.id), ghlContactIds: people(12).map((p) => `g${p.id}`) },
    ]);

    const planned = await planActivityRefresh({ scope: { kind: "filters" }, filters: FILTERS, clientIds: null });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.personCount).toBe(12);
    expect(planned.plan.estimatedCalls).toBe(12);
  });

  it("refuses when the PUSHED population is over the cap, stating true numbers", async () => {
    const pushed = MAX_FILTERED_PEOPLE + 1;
    tryCountFilteredPeople.mockResolvedValue(pushed);
    getAllFilteredPeople.mockResolvedValue(people(pushed));
    getClientsForPeople.mockResolvedValue([
      {
        clientId: "c1",
        personCount: pushed,
        personIds: people(pushed).map((p) => p.id),
        ghlContactIds: people(pushed).map((p) => `g${p.id}`),
      },
    ]);

    const planned = await planActivityRefresh({ scope: { kind: "filters" }, filters: FILTERS, clientIds: null });

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.code).toBe("too_many_filtered");
    expect(planned.error).toContain(`${pushed.toLocaleString("en-US")} of the ${pushed.toLocaleString("en-US")} people`);
    expect(planned.error).toContain("pushed to GHL");
  });

  it("leaves an explicit id selection to MAX_TARGETED_IDS, not to the filter caps", async () => {
    // A `kind: "ids"` scope is already capped at parse time; the filtered
    // caps must not fire on it and make the refusal say "filters".
    getClientsForPeople.mockResolvedValue([
      { clientId: "c1", personCount: 2, personIds: ["p1", "p2"], ghlContactIds: ["g1", "g2"] },
    ]);

    const planned = await planActivityRefresh({
      scope: { kind: "ids", personIds: ["p1", "p2"] },
      filters: FILTERS,
      clientIds: null,
    });

    expect(planned.ok).toBe(true);
    expect(tryCountFilteredPeople).not.toHaveBeenCalled();
    expect(getAllFilteredPeople).not.toHaveBeenCalled();
  });
});
