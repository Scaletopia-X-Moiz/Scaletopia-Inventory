/** What an activity sync job is allowed to look at, and how that scope is
 * carried on the job row.
 *
 * Deliberately free of `server-only` and of every I/O import: the endpoint,
 * the worker and the sync core all need to agree on these rules, and the rules
 * themselves are pure enough to test without a database
 * (lib/ghl/activity-scope.test.ts).
 *
 * See docs/features/ghl-last-activity/multi-subaccount-contract.md Decisions
 * 1-4 for why the shape is what it is. */

/** The `job_id` every row of the SHARED incremental work list carries.
 *
 * `ghl_activity_queue.job_id` is part of the primary key, so it cannot be
 * NULL; the all-zero uuid is the sentinel for "this row belongs to the
 * client's ongoing incremental queue rather than to one particular job".
 *
 * Why a job_id exists at all: the queue used to be keyed
 * `(client_id, ghl_contact_id)` and the sync only enqueues when the queue is
 * empty. Two jobs for one client therefore shared one work list — a targeted
 * job could drain the rows another job had queued and then report success
 * while the other job reported "nothing to do". Scoping every queue operation
 * by job_id is what makes N concurrent jobs per client (Decision 1) safe. */
export const INCREMENTAL_QUEUE_JOB_ID = "00000000-0000-0000-0000-000000000000";

/** Ceiling on a `kind: "ids"` scope.
 *
 * The id set is stored verbatim in `push_jobs.options`, so it has to stay
 * small enough to be a sane jsonb value — 2,000 uuids is ~74 KB, which is
 * fine; 100,000 would not be. Above the cap the caller is expected to send
 * `kind: "filters"` instead, which is resolved server-side into the job's own
 * queue partition (MAX_FILTERED_PEOPLE) rather than onto the job row. */
export const MAX_TARGETED_IDS = 2000;

/** Ceiling on how many people a `kind: "filters"` refresh may resolve to.
 *
 * Much larger than MAX_TARGETED_IDS because the two caps are protecting
 * different things: an id set costs jsonb on a row rewritten by every
 * progress tick, whereas a resolved filter costs one `ghl_activity_queue`
 * insert — rows the queue was built to hold, and which a first full sweep of
 * a big location already writes tens of thousands of.
 *
 * 25,000 is set by the API budget, not by storage. Each person costs ~1
 * `messages/export` call per sub-account, the drain sustains ~8 calls/sec, and
 * the per-location ceiling is 150,000 calls/day: 25,000 contacts is ~52
 * minutes of wall clock and ~17% of one location's day. Ten times that would
 * be most of a day's quota spent on one click, which is the thing the user
 * cannot undo and should have to narrow their way into. Above the cap the
 * refresh is refused with `too_many_filtered` rather than truncated — half a
 * refresh reported as a whole one is the failure mode this feature exists to
 * avoid. */
export const MAX_FILTERED_PEOPLE = 25_000;

/** Ceiling on how many people a filtered refresh will RESOLVE in order to
 * price itself.
 *
 * Separate from MAX_FILTERED_PEOPLE because it protects a different thing.
 * MAX_FILTERED_PEOPLE is about GHL's budget and applies to the people who
 * actually cost a call (the ones with a `platform_pushes` row). This one is
 * about ours: working out who those people are means fetching every matching
 * person row and asking `platform_pushes` about all of them, and the preview
 * does it again every time the user changes their mind in the dialog. A
 * filter matching the whole 136k table would materialize 136k rows per click
 * to discover that twelve of them were ever pushed.
 *
 * Set well above MAX_FILTERED_PEOPLE so that a refresh is never refused for
 * being too expensive to price when it would have been accepted on cost —
 * anything under this resolves, and is then judged on the population that
 * actually spends API calls. */
export const MAX_FILTER_SCAN = 50_000;

/** A targeted set of people, named by the caller. */
export interface ActivityIdsScope {
  kind: "ids";
  personIds: string[];
}

/** "Everything this client has pushed to GHL."
 *
 * Only ever reaches a job with an EMPTY filter snapshot — the legacy
 * `{ clientId, full }` body, and the dialog's whole-sub-account refresh. A
 * request whose filters actually narrow something is resolved at enqueue time
 * and stored as `kind: "queued"` instead, so that a job can no longer claim a
 * filtered scope while refreshing the entire pushed set. */
export interface ActivityFiltersScope {
  kind: "filters";
}

/** A work list that was resolved from a filter ONCE, at enqueue time, and
 * written straight into this job's own `ghl_activity_queue` partition.
 *
 * Server-minted only: `parseActivityScope` rejects it off the wire, because a
 * caller claiming "my contacts are already queued" when they are not would
 * produce a job that reports success having done nothing.
 *
 * Why the ids do not live on the job: a filter can match 25,000 people, and
 * `push_jobs.options` is rewritten on every progress tick. Why the sync does
 * not re-resolve the filter per tick instead: `platform_pushes` is one of the
 * filter's own inputs and the sync mutates it as it runs, and `within_days`
 * re-evaluates against now() — the population would drift under the job,
 * which is unbounded in both directions.
 *
 * The snapshot can therefore go stale between enqueue and drain. That is the
 * same trade a push job already makes, and it is the bounded one. */
export interface ActivityQueuedScope {
  kind: "queued";
  /** Distinct people the filter resolved to for THIS client, kept so the job
   * row can still say what it was asked to do once its queue has drained. */
  personCount: number;
  /** The partition this job drains, when it is NOT the job's own id.
   *
   * Only a continuation job sets it. A job stopped by the daily API budget
   * keeps its undrained rows (they are the only record of the work for a
   * filtered refresh — the job row carries a count, not the ids), and the
   * worker later queues a fresh job that ADOPTS that partition rather than
   * re-resolving a filter that has since drifted. Resume is therefore
   * "another job, same work list", which is the only resume the job table
   * can express: `push_jobs` has no run-after column and
   * `claim_next_runnable_job` takes the oldest queued row, so a job parked
   * back to `queued` would be re-claimed immediately and spin against a
   * budget that cannot clear until the UTC day rolls over. */
  queueJobId?: string;
}

export type ActivityScope = ActivityIdsScope | ActivityFiltersScope | ActivityQueuedScope;

/** True when this scope names specific people, and therefore when the sweep
 * must be skipped (Decision 3): the sweep exists to DISCOVER which contacts
 * moved, and a caller that names the contacts has already done that discovery.
 * A cold sweep costs ~138s against the Internal location, which would dwarf a
 * 30-contact refresh — and, more importantly, a sweep writes
 * `ghl_activity_sweeps`, whose high-water mark must only ever be advanced by a
 * pass that actually walked the location. */
export function isTargetedScope(scope: ActivityScope | undefined): scope is ActivityIdsScope {
  return scope?.kind === "ids";
}

/** The `job_id` a job's queue rows are written under.
 *
 * A job with its own work list gets its own partition; only a plain
 * incremental run joins the shared one. A continuation job drains the
 * partition it adopted (`scope.queueJobId`) rather than one named after
 * itself — see ActivityQueuedScope. */
export function queueJobIdFor(jobId: string, scope: ActivityScope | undefined, full = false): string {
  if (!ownsQueuePartition(scope, full)) return INCREMENTAL_QUEUE_JOB_ID;
  return (scope?.kind === "queued" && scope.queueJobId) || jobId;
}

/** True when this job's work list is its own: already resolved (by the caller
 * naming ids, by the endpoint resolving a filter and pre-filling the queue,
 * or by `full` meaning "every contact this client ever pushed") rather than
 * discovered by sweeping the location.
 *
 * Two consequences, and they travel together: the job reads and writes its
 * own queue partition, and it must never sweep — a sweep would both re-widen
 * the scope back to the whole client and advance a high-water mark this run
 * has not earned (Decision 3).
 *
 * `full` is in here because a full re-read writes the BIGGEST work list of
 * any kind — the client's entire pushed set — and it does not sweep, so it
 * never calls `recordSweep`. Sharing the sentinel partition made that set
 * indistinguishable from the incremental backlog: if the full job died, the
 * next post-push auto-sync saw `pending > 0`, skipped its own sweep, drained
 * the abandoned set, paid its full API cost, reported it as its own progress
 * and never advanced the sweep mark. That is exactly the corruption the
 * job_id column exists to prevent.
 *
 * A plain incremental run keeps the sentinel, and that is safe for the one
 * reason the other kinds do not share: its queue rows ARE the client's
 * across-runs resume cursor. They were put there by a sweep that advanced
 * `ghl_activity_sweeps` to cover them, every incremental run is doing the
 * same client-wide job as every other, and the `pending > 0 → skip the
 * sweep` rule is the intended handover, not a collision. Giving each
 * incremental run a private partition would instead strand that backlog:
 * nothing would ever drain the rows of a run that died. */
export function ownsQueuePartition(scope: ActivityScope | undefined, full = false): boolean {
  return full === true || scope?.kind === "ids" || scope?.kind === "queued";
}

/** True when this job's work list cannot be rebuilt if its queue partition is
 * thrown away — the test that decides whether an unexpected failure gets the
 * adopt-and-retry treatment or just discards and fails.
 *
 * Only `kind: "queued"` qualifies. The other two private-partition kinds
 * rebuild themselves from scratch, so losing their rows costs a re-run, not
 * the information:
 *
 *   `kind: "ids"` — the person ids are stored verbatim in `push_jobs.options`
 *                   (bounded at MAX_TARGETED_IDS precisely so they can be); a
 *                   fresh job with the same scope re-derives the identical
 *                   work list from the client's pushed contacts.
 *   `full`        — the work list IS "every contact this client has pushed", a
 *                   property of the client, re-derived the same way.
 *   incremental   — the shared sentinel partition, which is never any one
 *                   job's remainder and is never discarded or adopted.
 *
 * `kind: "queued"` is the one that cannot: the job row carries a personCount,
 * the ids exist only as queue rows, and the filter that produced them is not
 * honestly re-resolvable (`platform_pushes` is one of its own inputs and the
 * sync writes it as it runs; `within_days` re-evaluates against now()). It was
 * snapshotted deliberately, and once dropped it is gone. */
export function hasIrreplaceableWorkList(scope: ActivityScope | undefined, full = false): boolean {
  return ownsQueuePartition(scope, full) && scope?.kind === "queued";
}

export type ParsedScope =
  | { ok: true; scope: ActivityScope }
  | { ok: false; error: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Validates the `scope` member of a refresh request body.
 *
 * `undefined` is legal and means `{ kind: "filters" }` — that is what the
 * legacy `{ clientId, full }` body (which has a live button behind it) maps
 * to, and it is also the natural default for "refresh this whole
 * sub-account". Anything else malformed is a 400 rather than a silent
 * downgrade, because quietly turning a 2,000-person targeted refresh into a
 * whole-client one is the sort of mistake that only shows up as an API bill. */
export function parseActivityScope(raw: unknown): ParsedScope {
  if (raw === undefined || raw === null) return { ok: true, scope: { kind: "filters" } };
  if (typeof raw !== "object") return { ok: false, error: "scope must be an object" };

  const kind = (raw as { kind?: unknown }).kind;
  if (kind === "filters") return { ok: true, scope: { kind: "filters" } };
  if (kind !== "ids") return { ok: false, error: `Unknown scope kind "${String(kind)}"` };

  const personIds = (raw as { personIds?: unknown }).personIds;
  if (!Array.isArray(personIds)) {
    return { ok: false, error: "scope.personIds must be an array of person ids" };
  }

  // De-duplicated before the cap is applied, so a caller that sends the same
  // id twice isn't punished for it — and so the stored snapshot is the set it
  // claims to be.
  const unique = Array.from(new Set(personIds.filter(isNonEmptyString)));
  if (unique.length === 0) {
    return { ok: false, error: "scope.personIds must contain at least one person id" };
  }
  if (unique.length > MAX_TARGETED_IDS) {
    return {
      ok: false,
      error:
        `Too many people selected (${unique.length}). At most ${MAX_TARGETED_IDS} can be refreshed by id — ` +
        `refresh by filter instead.`,
    };
  }

  return { ok: true, scope: { kind: "ids", personIds: unique } };
}

/** Reads a scope back off a stored `push_jobs.options` blob.
 *
 * Tolerant on purpose: a job queued before this column existed has no scope
 * and must keep behaving exactly as it did (whole-client, sweep-first), and a
 * blob we can't make sense of degrades to the same safe default rather than
 * failing a job the user is watching. */
export function scopeFromJobOptions(options: Record<string, unknown> | null | undefined): ActivityScope {
  const raw = options?.scope;
  // Read here but not in parseActivityScope: "queued" is minted by the
  // endpoint after it has actually written the rows, so it is legal on a
  // stored job and never legal on a request.
  if (typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "queued") {
    const count = (raw as { personCount?: unknown }).personCount;
    const adopted = (raw as { queueJobId?: unknown }).queueJobId;
    return {
      kind: "queued",
      personCount: typeof count === "number" ? count : 0,
      ...(isNonEmptyString(adopted) ? { queueJobId: adopted } : {}),
    };
  }
  const parsed = parseActivityScope(raw);
  return parsed.ok ? parsed.scope : { kind: "filters" };
}

/** The marker a budget-stopped activity job leaves on its own `options`, so
 * the worker can pick its undrained work back up once the UTC day rolls over.
 *
 * Why a marker and not a job status: a budget stop is "come back tomorrow",
 * and the job table cannot express that. `claim_next_runnable_job` takes the
 * oldest `queued` row with no run-after predicate, so a parked job would be
 * re-claimed within seconds, burn another reservation discovering the budget
 * is still gone, and either spin the worker or starve every job behind it.
 * The job therefore finishes (honestly: "stopped, N done, M left"), its queue
 * partition is LEFT IN PLACE, and this marker records which partition is
 * waiting and which day's budget exhausted it. */
export interface ActivityBudgetStopMarker {
  /** UTC day (`budgetDay()`) whose budget ran out. A resume may only happen
   * on a LATER day — that comparison is the whole anti-spin mechanism. */
  day: string;
  /** The `ghl_activity_queue` partition still holding the undrained work. */
  queueJobId: string;
}

export const BUDGET_STOP_OPTION_KEY = "budgetStop";

/** Reads the marker back off a stored `push_jobs.options` blob, or null when
 * there isn't a usable one. Tolerant in the same way `scopeFromJobOptions`
 * is: a blob we cannot make sense of means "nothing to resume" rather than a
 * crashed worker invocation. */
export function budgetStopMarkerFrom(
  options: Record<string, unknown> | null | undefined
): ActivityBudgetStopMarker | null {
  const raw = options?.[BUDGET_STOP_OPTION_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const day = (raw as { day?: unknown }).day;
  const queueJobId = (raw as { queueJobId?: unknown }).queueJobId;
  if (!isNonEmptyString(day) || !isNonEmptyString(queueJobId)) return null;
  // The sentinel is the shared incremental partition and is nobody's private
  // remainder: a continuation job adopting it would drain the client's whole
  // backlog under a scope that claims to be a resolved work list.
  if (queueJobId === INCREMENTAL_QUEUE_JOB_ID) return null;
  return { day, queueJobId };
}

/** True when `marker` is waiting on a day that has already passed, i.e. its
 * budget has reset and the remainder can run. */
export function isResumableOn(marker: ActivityBudgetStopMarker, today: string): boolean {
  return marker.day < today;
}

// ---------------------------------------------------------------------------
// Unexpected failure: the same "the work list outlives the job row" treatment
// as a budget stop, plus the one thing a budget stop does not need — a bounded
// attempt count.
// ---------------------------------------------------------------------------

/** The marker an activity job leaves on its own `options` when a tick threw
 * for an unexpected reason and its queue partition still holds work.
 *
 * Why this exists at all: for a `kind: "queued"` (filtered) refresh the person
 * ids live ONLY as `ghl_activity_queue` rows — the job row carries a
 * `personCount`, and the filter that produced them cannot be honestly
 * re-resolved (it reads `platform_pushes`, which the sync writes as it runs,
 * and `within_days` re-evaluates against now()). So a single transient throw —
 * `Timed out acquiring connection from connection pool` is a live condition on
 * this project (handoff §14.5.8) — used to permanently destroy the undrained
 * remainder of a refresh of up to MAX_FILTERED_PEOPLE people.
 *
 * It is deliberately NOT the budget-stop marker under another name. A budget
 * stop is "come back tomorrow, nothing is wrong": unlimited waits, paced by a
 * day boundary, reported as `partial`. A failure is "something went wrong, try
 * a couple more times": bounded attempts, paced by elapsed wall clock, reported
 * as `failed`, and on exhaustion the remainder is dropped and SAID to be
 * dropped. */
export interface ActivityFailureRetryMarker {
  /** The `ghl_activity_queue` partition still holding the undrained work. */
  queueJobId: string;
  /** How many retries this work list has now been scheduled for, counting the
   * one this marker represents. 1 on the first failure. Bounded by
   * MAX_ACTIVITY_RETRY_ATTEMPTS. */
  attempt: number;
  /** When the failure happened (ISO). Doubles as the pacing clock AND as the
   * claim predicate — `claimActivityJobMarker` conditions its update on this
   * exact value, so two overlapping worker invocations cannot both adopt one
   * partition. */
  failedAt: string;
  /** What went wrong, kept so the continuation's own log line (and a human
   * reading the row) can see the chain's original cause. */
  reason: string;
}

export const FAILURE_RETRY_OPTION_KEY = "failureRetry";

/** Where the running retry count is carried onto a continuation job, so the
 * chain remembers how many attempts it has already spent. Without it every
 * continuation would start from zero and a deterministically-failing partition
 * would resurrect itself forever. */
export const RETRY_ATTEMPT_OPTION_KEY = "retryAttempt";

/** Retries a failed partition gets before it is dropped. Two — so a partition
 * is attempted three times in all.
 *
 * Not one: the failure this is actually written for (a Supabase connection-pool
 * timeout) is transient and usually gone on the next attempt, and one retry
 * leaves no margin for a second unlucky minute.
 *
 * Not five or unbounded: each attempt re-reads a partition of up to
 * MAX_FILTERED_PEOPLE contacts against the location's daily GHL budget, so a
 * retry is not cheap — and a partition that is poison (a client whose
 * credentials are gone, a row the write-back cannot accept) fails identically
 * every time. Three attempts is enough to distinguish "unlucky" from "broken"
 * while capping the wasted quota at 3x and the added latency at ~12 minutes. */
export const MAX_ACTIVITY_RETRY_ATTEMPTS = 2;

/** How long after the failure each retry may start, indexed by attempt - 1.
 *
 * Pacing has to be app-side wall clock: unlike a budget stop there is no day
 * rollover to wait for, `push_jobs` has no run-after column, and
 * `claim_next_runnable_job` takes the oldest queued row the moment it exists.
 * The resume scan runs at the top of EVERY worker invocation — cron fires one a
 * minute, but a self-chain or a route kick can fire several a second — so
 * without a delay a failing partition would be re-enqueued immediately, burn
 * all its attempts inside one minute against a transient fault that had no time
 * to clear, and hammer the GHL API on the way.
 *
 * 2 minutes first: longer than any plausible pool-timeout recovery and longer
 * than one cron period, so the retry lands on a genuinely later invocation.
 * 10 minutes second: if two minutes was not enough the fault is not a blip, and
 * the last attempt is worth spending on a meaningfully different moment.
 *
 * Clock skew between serverless instances can only shift these delays, never
 * remove the bound: `attempt` is what makes the chain terminate, and it is
 * stored, not timed. */
export const ACTIVITY_RETRY_BACKOFF_MS = [120_000, 600_000] as const;

/** Reads the retry marker back off a stored `push_jobs.options` blob, or null
 * when there isn't a usable one. Tolerant in the same way `budgetStopMarkerFrom`
 * is: an unreadable blob means "nothing to resume", not a crashed invocation. */
export function failureRetryMarkerFrom(
  options: Record<string, unknown> | null | undefined
): ActivityFailureRetryMarker | null {
  const raw = options?.[FAILURE_RETRY_OPTION_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const queueJobId = (raw as { queueJobId?: unknown }).queueJobId;
  const failedAt = (raw as { failedAt?: unknown }).failedAt;
  const attempt = (raw as { attempt?: unknown }).attempt;
  if (!isNonEmptyString(queueJobId) || !isNonEmptyString(failedAt)) return null;
  if (typeof attempt !== "number" || !Number.isFinite(attempt) || attempt < 1) return null;
  // Same hard rule as the budget-stop marker: the all-zero sentinel is the
  // SHARED incremental partition and is nobody's private remainder. A
  // continuation adopting it would drain the client's whole backlog under a
  // scope claiming to be one resolved work list.
  if (queueJobId === INCREMENTAL_QUEUE_JOB_ID) return null;
  const reason = (raw as { reason?: unknown }).reason;
  return {
    queueJobId,
    attempt,
    failedAt,
    reason: isNonEmptyString(reason) ? reason : "",
  };
}

/** How many retries the chain this job belongs to has already spent. 0 for a
 * job that is not itself a continuation. */
export function retryAttemptsSpent(options: Record<string, unknown> | null | undefined): number {
  const raw = options?.[RETRY_ATTEMPT_OPTION_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

/** True when `marker`'s backoff has elapsed and its remainder may run.
 *
 * An unparseable `failedAt` is treated as due rather than parked forever: the
 * attempt count already bounds the chain, so the worst case is one retry that
 * starts early, not a loop. */
export function isRetryDueAt(marker: ActivityFailureRetryMarker, now: Date = new Date()): boolean {
  const failedMs = Date.parse(marker.failedAt);
  if (Number.isNaN(failedMs)) return true;
  const backoff =
    ACTIVITY_RETRY_BACKOFF_MS[Math.min(marker.attempt, ACTIVITY_RETRY_BACKOFF_MS.length) - 1] ??
    ACTIVITY_RETRY_BACKOFF_MS[ACTIVITY_RETRY_BACKOFF_MS.length - 1];
  return now.getTime() - failedMs >= backoff;
}

export type ActivityFailurePlan =
  | { outcome: "retry"; marker: ActivityFailureRetryMarker; error: string }
  | { outcome: "exhausted"; error: string };

function peopleWord(n: number): string {
  return n === 1 ? "contact" : "contacts";
}

/** The error text for a terminal failure whose undrained remainder is being
 * thrown away. Says plainly that the work did NOT happen and how much of it,
 * because the one thing worse than losing the remainder is reporting a refresh
 * as finished when most of it never ran. */
export function droppedRemainderMessage(reason: string, remaining: number): string {
  return (
    `${reason} The remaining ${remaining.toLocaleString("en-US")} ${peopleWord(remaining)} were ` +
    `DROPPED and have NOT been refreshed — re-run the refresh for them.`
  );
}

/** Decides what happens to a failed job's undrained partition: one more
 * (paced, counted) attempt, or a clean, loudly-reported give-up.
 *
 * Pure so the policy can be tested without a database. The caller is
 * responsible for having established that the partition is both private and
 * irreplaceable, and that `remaining > 0`. */
export function planActivityFailureRetry(input: {
  reason: string;
  queueJobId: string;
  remaining: number;
  /** Retries the chain has already spent (`retryAttemptsSpent` of the failing
   * job's options). */
  spent: number;
  now?: Date;
}): ActivityFailurePlan {
  const { reason, queueJobId, remaining, spent } = input;
  const totalAttempts = MAX_ACTIVITY_RETRY_ATTEMPTS + 1;

  if (spent >= MAX_ACTIVITY_RETRY_ATTEMPTS) {
    return {
      outcome: "exhausted",
      error:
        `${reason} Giving up after ${totalAttempts} attempts. ` +
        droppedRemainderMessage("", remaining).trim(),
    };
  }

  const attempt = spent + 1;
  const now = input.now ?? new Date();
  const delayMs = ACTIVITY_RETRY_BACKOFF_MS[attempt - 1] ?? ACTIVITY_RETRY_BACKOFF_MS[0];
  const minutes = Math.round(delayMs / 60_000);
  return {
    outcome: "retry",
    marker: { queueJobId, attempt, failedAt: now.toISOString(), reason },
    error:
      `${reason} The remaining ${remaining.toLocaleString("en-US")} ${peopleWord(remaining)} stay queued ` +
      `and retry automatically in about ${minutes} ${minutes === 1 ? "minute" : "minutes"} ` +
      `(attempt ${attempt + 1} of ${totalAttempts}).`,
  };
}
