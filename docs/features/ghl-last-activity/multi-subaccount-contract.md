# Contract: targeted multi-sub-account activity refresh

Written 2026-10-01 by the orchestrating session. This file is the **shared
contract** every build agent works against. Decisions here are settled — an
agent that wants to deviate must say so and stop, not improvise.

Read `handoff.md` §14-16 first for why the existing design is shaped as it is.

---

## The goal

1. User selects N people in the People table and hits "Refresh last activity".
2. Those people are refreshed across **every sub-account they were pushed to**,
   not one.
3. Pushing a very large batch to GHL must not be able to melt the API budget.

---

## Decision 1 — N jobs, one per sub-account. Never one job looping clients.

`push_jobs.client_id` is NOT NULL and `claim_next_runnable_job` serializes on
it. That serialization is the only thing preventing a sync and a push from
fighting over one location's burst budget. A job that spans clients would run
outside that guard.

So: the refresh endpoint resolves which clients are involved and enqueues one
`ghl_activity` job per client. The response returns `jobIds: string[]`.

No `client_id` schema change. No new worker dispatch path.

## Decision 2 — the queue gets a `job_id`, fixing a live bug on the way

`ghl_activity_queue` is keyed `(client_id, ghl_contact_id)` and
`sync-activity.ts` only enqueues when `pending === 0`. Two jobs for one client
therefore corrupt each other's work list — a targeted job can silently drain
another job's rows and report success.

Fix: add `job_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'`.
The all-zero sentinel means "the shared incremental queue" (NULL cannot be used,
it is part of the primary key). Every queue operation filters on `job_id`.

PK becomes `(client_id, job_id, ghl_contact_id)`.

## Decision 3 — targeted mode skips the sweep entirely

The sweep exists to *discover* which contacts moved. When the caller names the
contacts, discovery is already done — and the sweep costs ~138s per cold
location, which would dwarf a 30-contact refresh.

Skipping it is safe: `recordSweep` has exactly one call site
(`sync-activity.ts:399`), inside the non-`full` branch. A targeted run therefore
leaves `last_message_date_ms`, `full_sweep_completed_at` and `sweep_cursor_ms`
untouched, so the next incremental run behaves identically. **Do not change
that.** A targeted run must never write `ghl_activity_sweeps`.

## Decision 4 — scope is carried as a stored id set, never a giant jsonb array

`push_jobs.options` holding 100k ids is not acceptable. Two scope kinds:

```ts
type ActivityScope =
  | { kind: "ids"; personIds: string[] }   // bounded: reject over MAX_TARGETED_IDS
  | { kind: "filters" }                     // reuse the existing filters snapshot
```

`kind: "ids"` is capped at **2,000** person ids (`MAX_TARGETED_IDS`). Above that
the caller must use `kind: "filters"`, which reuses the `filters jsonb` snapshot
the push path already stores and re-resolves per tick.

### Amendment (2026-10-01) — `kind: "filters"` is resolved at enqueue time

As shipped, the sync IGNORED the stored filter snapshot and refreshed the
client's entire pushed set, while the dialog told the user it was refreshing
the filtered set. Re-resolving per tick (as this decision assumed) is not
available: `platform_pushes` is one of the filter's own inputs and the sync
writes to it as it runs, and `within_days` re-evaluates against now() — the
population drifts under a running job.

So the endpoint resolves the filter ONCE, through `getAllFilteredPeople` (the
same resolver the table, the export and the push preview use), and writes the
resulting contacts straight into `ghl_activity_queue` under the job's own
job_id. The queue is already the durable, resumable, bounded work list; a
25,000-id array in `push_jobs.options` — rewritten on every progress tick — is
not. The stored scope becomes a third kind:

```ts
| { kind: "queued"; personCount: number }   // server-minted, never accepted off the wire
```

which behaves exactly like `kind: "ids"` from the sync's point of view (own
queue partition, no sweep, nothing to resolve). The snapshot can go stale
between enqueue and drain — the same trade a push job already makes, and the
bounded one.

A filter is capped at **25,000** people (`MAX_FILTERED_PEOPLE`), above which
the endpoint returns 400 `too_many_filtered`. The cap is set by the API
budget, not storage: ~1 export call per person per sub-account, ~8 calls/sec,
150,000 calls/day/location — 25,000 is ~52 minutes and ~17% of a location's
day.

`kind: "filters"` now survives only for an EMPTY filter snapshot (the legacy
`{ clientId, full }` body and the dialog's unfiltered view), where it keeps
its original meaning of "this whole sub-account" and still requires
`clientIds`.

## Decision 5 — the 100k-push guard has three layers

This is the part that matters most. A push of 100k contacts currently
auto-enqueues an activity sync that would make ~100k export calls — ~3.5 hours
of wall clock and half the 200k/day per-location cap, for data that in most
cases does not exist yet.

**Layer 1 — never read a contact that cannot have messages.**
A brand-new GHL contact has no conversation. `pushContactToGhl` already receives
GHL's `new` flag, turns it into `deduped` (`extractNewFlag`) and throws it away.
Persist it as `platform_pushes.was_deduped boolean`. The post-push auto-sync then
only reads contacts where `was_deduped = true`. Pushing 100k genuinely-new leads
becomes ~0 activity calls instead of 100k. This is the single biggest win and it
costs one column.

**Layer 2 — a per-location daily budget.**
New table `ghl_api_budget (ghl_location_id text, day date, calls int)`, keyed on
location rather than client because co-located clients share one real budget.
The sync checks remaining budget before each batch and stops cleanly (job stays
resumable, status reported) rather than burning into 429s. Default ceiling
**150,000/day**, leaving headroom under GHL's 200k.

**Layer 3 — location-level serialization.**
`claim_next_runnable_job` serializes on `client_id`, but three client rows share
location `MeFEd7scikKpI44Utr8N`. Two of them can run concurrently at concurrency
5 each → ~10-20 req/s against a 10 req/s ceiling → sustained 429s → and
`sync-activity.ts:458-475` *deletes contacts from the queue even when they fail*,
so contacts get silently dropped.

Extend the claim predicate to also exclude a job whose client shares a
`ghl_location_id` with any running job. Implemented inside the RPC as a join on
`clients`; non-GHL platforms keep the existing per-client behaviour.

## Decision 6 — `ghl_messages` uniqueness must include the client

`ghl_message_id text NOT NULL UNIQUE` is global. Two client rows sharing a
location see byte-identical message ids, and the upsert
(`onConflict: "ghl_message_id"`) then **overwrites the first client's
`person_id`/`client_id`** — last writer wins, and a person's drawer can go blank.

Change the constraint to `UNIQUE (ghl_message_id, client_id)` and the upsert's
`onConflict` to match. Re-syncing still upserts in place; co-located clients stop
stealing each other's rows.

Also: the comment at `ghl-activity.ts:220-223` claims the drawer falls back to
reading by conversation when a person has no rows. `getPersonGhlMessages` has no
such fallback. Either build it or delete the comment — do not leave it lying.

## Decision 7 — progress uses the existing Push Activity panel

That panel already polls a job *list* and merges by id every 1.5s, so N jobs
render correctly today with zero changes. The refresh button currently discards
its job id and toasts "track it in Push Activity".

Keep that. Return `jobIds[]`, toast "Refreshing N people across M sub-accounts".
Do **not** build a bespoke multi-job progress bar in this pass; a `batch_id`
grouping column is a follow-up, noted not built.

---

## API contract (frontend and backend both build to this)

`POST /api/people/refresh-ghl-activity`

```ts
// request
{
  scope: { kind: "ids"; personIds: string[] } | { kind: "filters" },
  clientIds?: string[],   // omitted = every client these people were pushed to
  full?: boolean,
}
// when scope.kind === "filters", the current filter query string is sent on the
// URL exactly as the push route does it (?q=...&...), not in the body.

// response 200
{ jobIds: string[], clientCount: number, personCount: number, estimatedCalls: number }
// personCount is the REAL resolved count for both scope kinds (it used to be
// 0 for filters); estimatedCalls is people x sub-accounts, an upper bound.
// response 400 { code, error } — empty scope, over MAX_TARGETED_IDS,
// over MAX_FILTERED_PEOPLE (`too_many_filtered`), no clients matched

`POST /api/people/refresh-ghl-activity/preview` — same body and query string,
resolves the same plan and enqueues nothing, so the confirm dialog can state
the real population and the real cost before the user commits. POST rather
than GET (unlike the push preview) because the scope can carry 2,000 ids.
```

Backwards compatibility: the old `{ clientId, full }` body must keep working and
map to `{ scope: {kind:"filters"}, clientIds: [clientId] }`. There is a live
button sending that shape.

New data function: `getClientsForPeople(personIds): Promise<{clientId, personCount}[]>`
— reads `platform_pushes` for the GHL platform, so the endpoint knows which
sub-accounts a selection actually touches.

---

## Hard rules for every agent

- **Do NOT run the full `npm test` suite** — the user states it is unreliable and
  `lib/data/people.test.ts` has 37 unbaselined failures. Run only the test files
  you touch.
- **Do NOT write `ghl_api_key` or any credential column.** That is blocked and is
  the user's to apply.
- All SQL goes in `lib/data/*.sql` with a matching rollback file. There is no
  `supabase/migrations` directory in this repo.
- Every live GHL test runs against the Internal sub-account only
  (`MeFEd7scikKpI44Utr8N`). Never touch another location.
- Clean up test rows you create. Do not delete the 10 `@rblaw.net` fixtures.
