/** The per-location daily API budget (Decision 5, layer 2).
 *
 * GHL's quota is per LOCATION, not per client row — three of our client rows
 * share location `MeFEd7scikKpI44Utr8N`, and a push and a sync to any of them
 * spend out of one pot. Layer 3 (the claim RPC's location-level
 * serialization) stops two of them running at once; this layer stops a single
 * very large run from spending the whole day's quota before anyone notices.
 *
 * Pure math and constants only — no I/O, so the policy can be tested without
 * a database (lib/ghl/activity-budget.test.ts). The counter itself lives in
 * `ghl_api_budget` and is read/reserved through lib/data/ghl-activity.ts. */

/** Calls per location per UTC day this app will spend before stopping.
 *
 * GHL's documented ceiling is 200,000/day; 150,000 leaves a quarter of the
 * day's quota for everything that does NOT go through this guard (pushes,
 * ad-hoc scripts, whatever a human runs by hand) rather than racing them to
 * the wall and discovering the limit as a wave of 429s. */
export const GHL_DAILY_CALL_BUDGET = 150_000;

/** Which bucket `now` falls in.
 *
 * UTC, not local: the counter is keyed `(location, day)` and is written by
 * serverless invocations whose local timezone is not ours to assume. A
 * consistent definition matters more than which day boundary it picks. */
export function budgetDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** What a reservation of `calls` costs us, clamped to something sane.
 *
 * The reservation is made BEFORE the calls are spent (see
 * `reserveGhlApiCalls`), so it has to be an upper bound on what the batch can
 * cost, never an estimate of what it probably will. */
export function reservationFor(calls: number): number {
  return Math.max(0, Math.ceil(calls));
}

export interface BudgetVerdict {
  /** True when the reservation left the location inside its ceiling and the
   * batch may proceed. */
  allowed: boolean;
  /** The post-reservation total the increment returned. */
  used: number;
  /** Calls still available after this reservation; never negative. */
  remaining: number;
}

/** The ceiling check itself, applied to the total `increment_ghl_api_budget`
 * returned.
 *
 * The RPC is a RESERVATION, not an accounting entry: it increments first and
 * hands back the new total, so two workers racing each other both see their
 * own post-increment value and at most one of them can be under the ceiling.
 * Doing it the other way round (read, decide, spend, record) lets every
 * concurrent worker read the same comfortable number and all spend on top of
 * it. A reservation is never refunded — a call that 429'd still consumed
 * quota, and over-counting is the safe direction to be wrong in. */
export function judgeBudget(
  postIncrementTotal: number,
  ceiling: number = GHL_DAILY_CALL_BUDGET
): BudgetVerdict {
  return {
    allowed: postIncrementTotal <= ceiling,
    used: postIncrementTotal,
    remaining: Math.max(0, ceiling - postIncrementTotal),
  };
}

/** The message a budget stop surfaces on the job row. Written as something an
 * operator can act on without reading this file: which location, how much,
 * and when it frees up. */
export function budgetStopReason(locationId: string, day: string, used: number): string {
  return (
    `Stopped: GHL location ${locationId} has used its daily API budget for ${day} ` +
    `(${used.toLocaleString("en-US")} of ${GHL_DAILY_CALL_BUDGET.toLocaleString("en-US")} calls). ` +
    `Nothing more will be read for this location until the budget resets at 00:00 UTC. ` +
    `Raise GHL_DAILY_CALL_BUDGET if the location's real ceiling allows it.`
  );
}
