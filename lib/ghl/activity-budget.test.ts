import { describe, expect, it } from "vitest";
import {
  GHL_DAILY_CALL_BUDGET,
  budgetDay,
  budgetStopReason,
  judgeBudget,
  reservationFor,
} from "@/lib/ghl/activity-budget";

/** The per-location daily budget's policy layer (Decision 5, layer 2). Pure,
 * so the behaviour AT the limit — the only place this matters — is pinned down
 * without needing a location that has actually spent 150,000 calls. */

describe("budgetDay", () => {
  it("buckets by UTC day, not by the server's local timezone", () => {
    // Serverless invocations don't share a timezone with us, and the counter is
    // keyed (location, day). A consistent boundary matters more than which one.
    expect(budgetDay(new Date("2026-10-01T23:59:59.999Z"))).toBe("2026-10-01");
    expect(budgetDay(new Date("2026-10-02T00:00:00.000Z"))).toBe("2026-10-02");
  });
});

describe("reservationFor", () => {
  it("never reserves a negative or fractional number of calls", () => {
    expect(reservationFor(0)).toBe(0);
    expect(reservationFor(-5)).toBe(0);
    expect(reservationFor(1.2)).toBe(2);
  });
});

describe("judgeBudget — behaviour at the limit", () => {
  it("allows a reservation that lands exactly on the ceiling", () => {
    expect(judgeBudget(GHL_DAILY_CALL_BUDGET)).toEqual({
      allowed: true,
      used: GHL_DAILY_CALL_BUDGET,
      remaining: 0,
    });
  });

  it("denies the first reservation that crosses it", () => {
    const verdict = judgeBudget(GHL_DAILY_CALL_BUDGET + 1);
    expect(verdict.allowed).toBe(false);
    expect(verdict.remaining).toBe(0);
  });

  it("reports what is left below the ceiling", () => {
    expect(judgeBudget(GHL_DAILY_CALL_BUDGET - 50).remaining).toBe(50);
  });

  it("never reports negative headroom once the location has overspent", () => {
    // Reservations are never refunded, so the stored total can legitimately sit
    // well past the ceiling; "remaining: -20,000" is not a useful thing to show.
    expect(judgeBudget(GHL_DAILY_CALL_BUDGET + 20_000).remaining).toBe(0);
  });

  it("leaves headroom under GHL's own 200k/day cap", () => {
    expect(GHL_DAILY_CALL_BUDGET).toBeLessThan(200_000);
  });

  it("honours an explicit ceiling, which is how the policy stays app-side", () => {
    expect(judgeBudget(10, 10).allowed).toBe(true);
    expect(judgeBudget(11, 10).allowed).toBe(false);
  });
});

describe("budgetStopReason", () => {
  it("names the location, the day and the ceiling, so an operator can act on it", () => {
    const reason = budgetStopReason("MeFEd7scikKpI44Utr8N", "2026-10-01", 150_001);
    expect(reason).toContain("MeFEd7scikKpI44Utr8N");
    expect(reason).toContain("2026-10-01");
    expect(reason).toContain("150,001");
    expect(reason).toContain("00:00 UTC");
  });
});
