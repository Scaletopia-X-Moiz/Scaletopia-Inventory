import { describe, expect, it } from "vitest";
import {
  ACTIVITY_RETRY_BACKOFF_MS,
  FAILURE_RETRY_OPTION_KEY,
  INCREMENTAL_QUEUE_JOB_ID,
  MAX_ACTIVITY_RETRY_ATTEMPTS,
  RETRY_ATTEMPT_OPTION_KEY,
  budgetStopMarkerFrom,
  droppedRemainderMessage,
  failureRetryMarkerFrom,
  hasIrreplaceableWorkList,
  isRetryDueAt,
  planActivityFailureRetry,
  retryAttemptsSpent,
  isResumableOn,
  MAX_TARGETED_IDS,
  isTargetedScope,
  ownsQueuePartition,
  parseActivityScope,
  queueJobIdFor,
  scopeFromJobOptions,
  type ActivityFailureRetryMarker,
  type ActivityScope,
} from "@/lib/ghl/activity-scope";

/** Pure scope rules: what the refresh endpoint accepts, and which partition of
 * `ghl_activity_queue` the resulting job owns. No I/O, so this runs without a
 * database — the queue-scoping bug these rules fix is the kind that only shows
 * up when two jobs overlap, which is exactly what a unit test can pin down and
 * an integration test cannot reliably reproduce. */

describe("parseActivityScope", () => {
  it("defaults a missing scope to filters, which is what the legacy body means", () => {
    expect(parseActivityScope(undefined)).toEqual({ ok: true, scope: { kind: "filters" } });
    expect(parseActivityScope(null)).toEqual({ ok: true, scope: { kind: "filters" } });
  });

  it("accepts an explicit filters scope", () => {
    expect(parseActivityScope({ kind: "filters" })).toEqual({ ok: true, scope: { kind: "filters" } });
  });

  it("accepts an ids scope and de-duplicates it", () => {
    const parsed = parseActivityScope({ kind: "ids", personIds: ["a", "b", "a"] });
    expect(parsed).toEqual({ ok: true, scope: { kind: "ids", personIds: ["a", "b"] } });
  });

  it("drops blank ids rather than enqueuing a job for them", () => {
    const parsed = parseActivityScope({ kind: "ids", personIds: ["a", "", "   ", 7] });
    expect(parsed).toEqual({ ok: true, scope: { kind: "ids", personIds: ["a"] } });
  });

  it("rejects an ids scope that resolves to nothing", () => {
    const parsed = parseActivityScope({ kind: "ids", personIds: ["", "  "] });
    expect(parsed.ok).toBe(false);
  });

  it("rejects more than MAX_TARGETED_IDS ids", () => {
    const ids = Array.from({ length: MAX_TARGETED_IDS + 1 }, (_, i) => `p${i}`);
    const parsed = parseActivityScope({ kind: "ids", personIds: ids });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Too many people selected");
  });

  it("accepts exactly MAX_TARGETED_IDS", () => {
    const ids = Array.from({ length: MAX_TARGETED_IDS }, (_, i) => `p${i}`);
    expect(parseActivityScope({ kind: "ids", personIds: ids }).ok).toBe(true);
  });

  it("de-duplicates BEFORE applying the cap, so a repeated id isn't punished", () => {
    const ids = Array.from({ length: MAX_TARGETED_IDS }, (_, i) => `p${i}`);
    expect(parseActivityScope({ kind: "ids", personIds: [...ids, ...ids] }).ok).toBe(true);
  });

  it("rejects an unknown kind rather than silently widening to the whole client", () => {
    expect(parseActivityScope({ kind: "everything" }).ok).toBe(false);
    expect(parseActivityScope({ kind: "ids" }).ok).toBe(false);
    expect(parseActivityScope("ids").ok).toBe(false);
  });
});

describe("queueJobIdFor — the fix for two jobs sharing one work list", () => {
  it("gives a targeted job its own partition", () => {
    expect(queueJobIdFor("job-1", { kind: "ids", personIds: ["p1"] })).toBe("job-1");
  });

  it("puts a whole-client job on the shared incremental partition", () => {
    // The incremental queue persists across runs and IS the resume cursor, so
    // it must NOT be split per job id.
    expect(queueJobIdFor("job-1", { kind: "filters" })).toBe(INCREMENTAL_QUEUE_JOB_ID);
    expect(queueJobIdFor("job-1", undefined)).toBe(INCREMENTAL_QUEUE_JOB_ID);
  });

  it("keeps two targeted jobs for one client apart", () => {
    const scope: ActivityScope = { kind: "ids", personIds: ["p1"] };
    expect(queueJobIdFor("job-a", scope)).not.toBe(queueJobIdFor("job-b", scope));
  });
});

describe("isTargetedScope — the sweep switch", () => {
  it("is true only for a named id set", () => {
    expect(isTargetedScope({ kind: "ids", personIds: ["p1"] })).toBe(true);
    expect(isTargetedScope({ kind: "filters" })).toBe(false);
    expect(isTargetedScope(undefined)).toBe(false);
  });
});

describe("scopeFromJobOptions", () => {
  it("reads a stored ids scope back", () => {
    expect(scopeFromJobOptions({ scope: { kind: "ids", personIds: ["p1"] } })).toEqual({
      kind: "ids",
      personIds: ["p1"],
    });
  });

  it("degrades a job row that predates the column, or a garbled one, to filters", () => {
    // A pre-existing queued job must keep behaving exactly as it did:
    // whole-client, sweep-first.
    expect(scopeFromJobOptions({ full: true })).toEqual({ kind: "filters" });
    expect(scopeFromJobOptions(null)).toEqual({ kind: "filters" });
    expect(scopeFromJobOptions({ scope: { kind: "nonsense" } })).toEqual({ kind: "filters" });
  });
});

describe("the pre-queued (filter-resolved) scope", () => {
  it("owns a private partition and so never sweeps, like a targeted job", () => {
    expect(ownsQueuePartition({ kind: "queued", personCount: 900 })).toBe(true);
    expect(ownsQueuePartition({ kind: "ids", personIds: ["p1"] })).toBe(true);
    expect(ownsQueuePartition({ kind: "filters" })).toBe(false);
    expect(queueJobIdFor("job-a", { kind: "queued", personCount: 900 })).toBe("job-a");
  });

  it("is not targeted, because it carries contacts rather than person ids", () => {
    // isTargetedScope gates the narrowed platform_pushes read, which needs
    // person ids a pre-queued job deliberately does not carry.
    expect(isTargetedScope({ kind: "queued", personCount: 900 })).toBe(false);
  });

  it("is server-minted: a request may not claim its contacts are already queued", () => {
    expect(parseActivityScope({ kind: "queued", personCount: 900 }).ok).toBe(false);
  });

  it("reads back off a job row, defaulting a garbled count rather than failing the job", () => {
    expect(scopeFromJobOptions({ scope: { kind: "queued", personCount: 900 } })).toEqual({
      kind: "queued",
      personCount: 900,
    });
    expect(scopeFromJobOptions({ scope: { kind: "queued" } })).toEqual({ kind: "queued", personCount: 0 });
  });
});

describe("a full re-read owns its own partition", () => {
  it("does not share the incremental sentinel", () => {
    // A full re-read writes the client's ENTIRE pushed set and never sweeps.
    // Sharing the sentinel meant an abandoned full job left `pending > 0`, so
    // the next post-push auto-sync skipped its own sweep, drained the
    // abandoned set, paid its full API cost, reported it as its own progress
    // and never called recordSweep.
    expect(ownsQueuePartition({ kind: "filters" }, true)).toBe(true);
    expect(queueJobIdFor("job-full", { kind: "filters" }, true)).toBe("job-full");
    expect(queueJobIdFor("job-full", undefined, true)).toBe("job-full");
  });

  it("leaves a plain incremental run on the shared partition", () => {
    // Its rows ARE the client's across-runs resume cursor, put there by a
    // sweep that already advanced the high-water mark to cover them. A
    // private partition per incremental run would strand that backlog.
    expect(ownsQueuePartition({ kind: "filters" }, false)).toBe(false);
    expect(queueJobIdFor("job-inc", { kind: "filters" }, false)).toBe(INCREMENTAL_QUEUE_JOB_ID);
    expect(queueJobIdFor("job-inc", undefined)).toBe(INCREMENTAL_QUEUE_JOB_ID);
  });
});

describe("resuming a budget-stopped job", () => {
  it("drains the partition it adopted, not one named after itself", () => {
    // The continuation is a different job row: `push_jobs` has no run-after
    // column, so the stopped job cannot simply be re-queued. The work list
    // stays where it is and the new job points at it.
    const scope: ActivityScope = { kind: "queued", personCount: 16_000, queueJobId: "stopped-job" };
    expect(queueJobIdFor("continuation-job", scope)).toBe("stopped-job");
    expect(ownsQueuePartition(scope)).toBe(true);
  });

  it("carries the adopted partition across a job row round trip", () => {
    expect(
      scopeFromJobOptions({ scope: { kind: "queued", personCount: 5, queueJobId: "part-1" } })
    ).toEqual({ kind: "queued", personCount: 5, queueJobId: "part-1" });
  });

  it("reads a marker only when it names a real private partition", () => {
    expect(budgetStopMarkerFrom({ budgetStop: { day: "2026-10-01", queueJobId: "part-1" } })).toEqual({
      day: "2026-10-01",
      queueJobId: "part-1",
    });
    expect(budgetStopMarkerFrom(null)).toBeNull();
    expect(budgetStopMarkerFrom({})).toBeNull();
    expect(budgetStopMarkerFrom({ budgetStop: { day: "2026-10-01" } })).toBeNull();
    // The sentinel is the SHARED incremental queue. A continuation adopting
    // it would drain the client's whole backlog under a scope claiming to be
    // one job's resolved work list.
    expect(
      budgetStopMarkerFrom({ budgetStop: { day: "2026-10-01", queueJobId: INCREMENTAL_QUEUE_JOB_ID } })
    ).toBeNull();
  });

  it("waits for the UTC day to roll over, which is what stops the worker spinning", () => {
    const marker = { day: "2026-10-01", queueJobId: "part-1" };
    // Same day: the budget has not reset, and re-queueing now would burn
    // another reservation discovering that.
    expect(isResumableOn(marker, "2026-10-01")).toBe(false);
    expect(isResumableOn(marker, "2026-10-02")).toBe(true);
    expect(isResumableOn(marker, "2026-11-01")).toBe(true);
  });
});

/** The bounded failure retry. A budget stop can wait forever because nothing
 * is wrong; an unexpected failure cannot, so these rules are about the two
 * things that keep a retry from becoming a resurrection loop — a counted
 * attempt limit, and a backoff that paces it — plus the one thing that keeps
 * giving up honest: saying how much work was dropped. */
describe("activity failure retry", () => {
  const retryMarker = (over: Partial<ActivityFailureRetryMarker> = {}): ActivityFailureRetryMarker => ({
    queueJobId: "part-1",
    attempt: 1,
    failedAt: "2026-10-01T12:00:00.000Z",
    reason: "Timed out acquiring connection from connection pool",
    ...over,
  });

  describe("failureRetryMarkerFrom", () => {
    it("reads a well-formed marker back off a job row", () => {
      expect(failureRetryMarkerFrom({ [FAILURE_RETRY_OPTION_KEY]: retryMarker() })).toEqual(retryMarker());
    });

    it("rejects a marker that names no partition, no time, or no attempt", () => {
      expect(failureRetryMarkerFrom(null)).toBeNull();
      expect(failureRetryMarkerFrom({})).toBeNull();
      expect(failureRetryMarkerFrom({ [FAILURE_RETRY_OPTION_KEY]: { queueJobId: "p", attempt: 1 } })).toBeNull();
      expect(
        failureRetryMarkerFrom({ [FAILURE_RETRY_OPTION_KEY]: { queueJobId: "p", failedAt: "x" } })
      ).toBeNull();
      expect(
        failureRetryMarkerFrom({ [FAILURE_RETRY_OPTION_KEY]: retryMarker({ attempt: 0 }) })
      ).toBeNull();
    });

    it("NEVER adopts the shared sentinel partition", () => {
      // The sentinel is the client's across-runs incremental cursor. A
      // continuation adopting it would drain the whole backlog under a scope
      // that claims to be one job's resolved work list — and the rows are not
      // this job's to discard either.
      expect(
        failureRetryMarkerFrom({
          [FAILURE_RETRY_OPTION_KEY]: retryMarker({ queueJobId: INCREMENTAL_QUEUE_JOB_ID }),
        })
      ).toBeNull();
    });
  });

  describe("retryAttemptsSpent", () => {
    it("is 0 for a job that is not a continuation", () => {
      expect(retryAttemptsSpent(undefined)).toBe(0);
      expect(retryAttemptsSpent({})).toBe(0);
      expect(retryAttemptsSpent({ [RETRY_ATTEMPT_OPTION_KEY]: "2" })).toBe(0);
      expect(retryAttemptsSpent({ [RETRY_ATTEMPT_OPTION_KEY]: -1 })).toBe(0);
    });

    it("carries the chain's count forward", () => {
      expect(retryAttemptsSpent({ [RETRY_ATTEMPT_OPTION_KEY]: 2 })).toBe(2);
    });
  });

  describe("isRetryDueAt", () => {
    const failedAt = "2026-10-01T12:00:00.000Z";
    const at = (ms: number) => new Date(Date.parse(failedAt) + ms);

    it("holds the first retry back for its backoff, so a self-chain can't instant-loop", () => {
      const marker = retryMarker({ attempt: 1, failedAt });
      expect(isRetryDueAt(marker, at(0))).toBe(false);
      expect(isRetryDueAt(marker, at(ACTIVITY_RETRY_BACKOFF_MS[0] - 1))).toBe(false);
      expect(isRetryDueAt(marker, at(ACTIVITY_RETRY_BACKOFF_MS[0]))).toBe(true);
    });

    it("backs the second retry off further", () => {
      const marker = retryMarker({ attempt: 2, failedAt });
      expect(isRetryDueAt(marker, at(ACTIVITY_RETRY_BACKOFF_MS[0]))).toBe(false);
      expect(isRetryDueAt(marker, at(ACTIVITY_RETRY_BACKOFF_MS[1]))).toBe(true);
    });

    it("treats an unreadable timestamp as due rather than parking the work forever", () => {
      // The attempt count, not the clock, is what bounds the chain — so the
      // safe degradation is one early retry, never an orphaned partition.
      expect(isRetryDueAt(retryMarker({ failedAt: "not a date" }), at(0))).toBe(true);
    });
  });

  describe("planActivityFailureRetry", () => {
    const base = {
      reason: "Timed out acquiring connection from connection pool",
      queueJobId: "part-1",
      remaining: 16_000,
      now: new Date("2026-10-01T12:00:00.000Z"),
    };

    it("schedules the first retry and keeps the partition", () => {
      const plan = planActivityFailureRetry({ ...base, spent: 0 });
      expect(plan.outcome).toBe("retry");
      if (plan.outcome !== "retry") throw new Error("unreachable");
      expect(plan.marker).toEqual({
        queueJobId: "part-1",
        attempt: 1,
        failedAt: "2026-10-01T12:00:00.000Z",
        reason: base.reason,
      });
      // The user is told the work survived, and how long it waits.
      expect(plan.error).toContain("16,000 contacts stay queued");
      expect(plan.error).toContain("attempt 2 of 3");
      expect(plan.error).not.toContain("DROPPED");
    });

    it("counts attempts across continuations rather than restarting", () => {
      const plan = planActivityFailureRetry({ ...base, spent: 1 });
      expect(plan.outcome).toBe("retry");
      if (plan.outcome !== "retry") throw new Error("unreachable");
      expect(plan.marker.attempt).toBe(2);
      expect(plan.error).toContain("attempt 3 of 3");
    });

    it("gives up once the attempts are spent, and says the remainder was dropped", () => {
      const plan = planActivityFailureRetry({ ...base, spent: MAX_ACTIVITY_RETRY_ATTEMPTS });
      expect(plan.outcome).toBe("exhausted");
      expect(plan.error).toContain("Giving up after 3 attempts");
      // The whole point: the user must not be told work completed when it did
      // not, and must be told how much of it is missing.
      expect(plan.error).toContain("16,000 contacts");
      expect(plan.error).toContain("DROPPED");
      expect(plan.error).toContain(base.reason);
    });

    it("never schedules past the limit, however many attempts a stale row claims", () => {
      for (const spent of [MAX_ACTIVITY_RETRY_ATTEMPTS, MAX_ACTIVITY_RETRY_ATTEMPTS + 5, 99]) {
        expect(planActivityFailureRetry({ ...base, spent }).outcome).toBe("exhausted");
      }
    });

    it("a marker it schedules is always one the resume scan will accept back", () => {
      // Round trip: plan → job options → read. A marker the reader rejects
      // would strand the partition with no resume signal at all.
      const plan = planActivityFailureRetry({ ...base, spent: 0 });
      if (plan.outcome !== "retry") throw new Error("unreachable");
      expect(failureRetryMarkerFrom({ [FAILURE_RETRY_OPTION_KEY]: plan.marker })).toEqual(plan.marker);
    });

    it("singularizes a one-person remainder", () => {
      expect(planActivityFailureRetry({ ...base, remaining: 1, spent: 0 }).error).toContain("1 contact stay");
    });
  });

  describe("hasIrreplaceableWorkList", () => {
    it("is true only for a pre-queued work list, the one that exists nowhere else", () => {
      expect(hasIrreplaceableWorkList({ kind: "queued", personCount: 25_000 })).toBe(true);
      expect(hasIrreplaceableWorkList({ kind: "queued", personCount: 9, queueJobId: "part-1" })).toBe(true);
    });

    it("is false for the kinds that can rebuild themselves from the job row", () => {
      // ids: the person ids are on the job row, bounded at MAX_TARGETED_IDS so
      // that they can be. full: the list is a property of the client.
      expect(hasIrreplaceableWorkList({ kind: "ids", personIds: ["a", "b"] })).toBe(false);
      expect(hasIrreplaceableWorkList({ kind: "filters" }, true)).toBe(false);
    });

    it("is false for a plain incremental run, which drinks from the shared sentinel", () => {
      expect(hasIrreplaceableWorkList({ kind: "filters" })).toBe(false);
      expect(hasIrreplaceableWorkList(undefined)).toBe(false);
      // And the sentinel is what such a run would be pointed at, so nothing
      // can adopt or discard it.
      expect(queueJobIdFor("job-1", { kind: "filters" })).toBe(INCREMENTAL_QUEUE_JOB_ID);
    });
  });

  describe("droppedRemainderMessage", () => {
    it("names the count so a failed row can't be mistaken for a finished one", () => {
      expect(droppedRemainderMessage("Client gone.", 2_500)).toBe(
        "Client gone. The remaining 2,500 contacts were DROPPED and have NOT been refreshed — " +
          "re-run the refresh for them."
      );
    });
  });
});
