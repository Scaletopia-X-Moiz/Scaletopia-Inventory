-- Targeted multi-sub-account activity refresh
-- (docs/features/ghl-last-activity/multi-subaccount-contract.md).
--
-- Follows lib/data/ghl-activity.sql, which is already applied to production and
-- must not be edited. Everything here is idempotent, but three of the five
-- pieces change an *existing* constraint rather than adding an object, and
-- `ADD CONSTRAINT` has no `IF NOT EXISTS` — so those are written as DO blocks
-- that inspect pg_constraint/pg_index and only act when the shape on disk is
-- not already the shape we want. Rollback: lib/data/ghl-activity-multi-rollback.sql.
--
-- Five pieces, in dependency order:
--   A. ghl_activity_queue.job_id    — Decision 2: stop two jobs for one client
--                                     draining each other's work list.
--   B. ghl_messages uniqueness      — Decision 6: stop co-located clients
--                                     stealing each other's message rows.
--   C. platform_pushes.was_deduped  — Decision 5 layer 1: don't read contacts
--                                     that cannot have messages.
--   D. ghl_api_budget               — Decision 5 layer 2: per-location daily
--                                     call ceiling.
--   E. claim_next_runnable_job      — Decision 5 layer 3: serialize on the GHL
--                                     location, not just the client row.
--
-- B, C and E each have a matching application-side change; C and E are safe to
-- apply ahead of the code (a nullable column nobody writes, and a claim
-- predicate that can only ever claim *fewer* jobs). A and B are not: the queue
-- gains a column every queue statement must filter on, and the upsert's
-- `onConflict` must name the new constraint. Apply those together with the code.

-- A. Per-job queue scoping ---------------------------------------------------
--
-- The sentinel, not NULL, because the column is part of the primary key and a
-- NULL key column would make every shared-queue row distinct from every other
-- (and unmatchable by an upsert's conflict target). The all-zero uuid reads as
-- "the shared incremental queue" — the rows a sweep produces for the client at
-- large, as opposed to the rows one targeted job owns.
--
-- Deliberately NOT a foreign key to push_jobs(id): the sentinel is not a job,
-- so an FK would reject every shared-queue row. The real rows are cleaned up
-- by the fetch phase deleting each batch as it drains, not by a cascade.
ALTER TABLE ghl_activity_queue
  ADD COLUMN IF NOT EXISTS job_id uuid NOT NULL
  DEFAULT '00000000-0000-0000-0000-000000000000';

-- Widening the primary key cannot be expressed idempotently in DDL, so compare
-- the live key's column list (in key order — order decides which prefixes the
-- backing index can serve) against the one we want, and only rewrite when they
-- differ. Re-running this after it has been applied does nothing and, in
-- particular, does not drop and rebuild the index on a table a running job may
-- be draining.
--
-- No data can be lost by the widening: every pre-existing row takes the
-- sentinel, and the old key already guaranteed (client_id, ghl_contact_id)
-- unique, so (client_id, sentinel, ghl_contact_id) is unique too.
DO $$
DECLARE
  pk_name text;
  pk_cols text[];
BEGIN
  SELECT c.conname,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
    INTO pk_name, pk_cols
  FROM pg_constraint c
  WHERE c.conrelid = 'ghl_activity_queue'::regclass
    AND c.contype = 'p';

  IF pk_cols IS DISTINCT FROM ARRAY['client_id', 'job_id', 'ghl_contact_id'] THEN
    IF pk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE ghl_activity_queue DROP CONSTRAINT %I', pk_name);
    END IF;
    ALTER TABLE ghl_activity_queue
      ADD CONSTRAINT ghl_activity_queue_pkey
      PRIMARY KEY (client_id, job_id, ghl_contact_id);
  END IF;
END
$$;

-- The drain reads one job's rows oldest-first, so the ordering index needs the
-- job between the client and the timestamp — otherwise a targeted job's drain
-- has to sort every row the shared queue is holding for that client. The old
-- (client_id, enqueued_at) index is dropped rather than kept: the new one
-- serves nothing less, and the only query that wanted the old shape was the
-- drain this change is replacing.
CREATE INDEX IF NOT EXISTS ghl_activity_queue_client_job_enqueued_idx
  ON ghl_activity_queue (client_id, job_id, enqueued_at);

DROP INDEX IF EXISTS ghl_activity_queue_client_enqueued_idx;

-- B. ghl_messages uniqueness is per client, not global ------------------------
--
-- GHL message ids are unique within a location, and three client rows share
-- location MeFEd7scikKpI44Utr8N — so a global UNIQUE makes the sync's upsert
-- overwrite the first client's person_id/client_id with the second's.
--
-- The composite constraint is added *before* the global one is dropped, so the
-- table is never momentarily unprotected, and so a failure adding it leaves
-- the old guard in place. The add can never fail on existing data: the global
-- constraint is strictly stronger, so any set of rows satisfying it already
-- satisfies (ghl_message_id, client_id).
--
-- The old constraint is found by shape rather than by name — `ghl_message_id
-- text NOT NULL UNIQUE` produced a system-named constraint, and this also
-- catches a bare unique index if one was ever created by hand instead.
DO $$
DECLARE
  idx         record;
  target_cols CONSTANT text[] := ARRAY['client_id', 'ghl_message_id']; -- name-sorted
  has_target  boolean := false;
  to_drop     text[] := '{}';   -- "CONSTRAINT <name>" / "INDEX <name>"
  stmt        text;
BEGIN
  FOR idx IN
    SELECT c.conname,
           i.indexrelid::regclass::text AS index_name,
           (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(
                     (string_to_array(i.indkey::text, ' ')::smallint[])[1:i.indnkeyatts]
                   ) AS k(attnum)
              JOIN pg_attribute a
                ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
    FROM pg_index i
    LEFT JOIN pg_constraint c
      ON c.conindid = i.indexrelid AND c.contype IN ('u', 'p')
    WHERE i.indrelid = 'ghl_messages'::regclass
      AND i.indisunique
      AND NOT i.indisprimary
  LOOP
    IF idx.cols = target_cols THEN
      has_target := true;
    ELSIF idx.cols = ARRAY['ghl_message_id'] THEN
      to_drop := to_drop || CASE
        WHEN idx.conname IS NOT NULL
          THEN format('ALTER TABLE ghl_messages DROP CONSTRAINT %I', idx.conname)
        ELSE format('DROP INDEX %s', idx.index_name)
      END;
    END IF;
  END LOOP;

  IF NOT has_target THEN
    ALTER TABLE ghl_messages
      ADD CONSTRAINT ghl_messages_message_client_key
      UNIQUE (ghl_message_id, client_id);
  END IF;

  FOREACH stmt IN ARRAY to_drop LOOP
    EXECUTE stmt;
  END LOOP;
END
$$;

-- C. Was this push a dedupe onto an existing GHL contact? ---------------------
--
-- GHL's create-contact response carries a `new` flag that pushContactToGhl
-- already reads and discards. Persisting its inverse is the cheapest of the
-- three budget layers and the largest win: a brand-new contact has no
-- conversation, so the post-push auto-sync can skip it outright and a push of
-- 100k genuinely-new leads costs ~0 activity calls instead of ~100k.
--
-- Nullable, and NULL does NOT mean false. It means "pushed before we recorded
-- this", which is every row that exists today — and some of those certainly
-- were dedupes onto contacts with real history. The sync must therefore treat
-- NULL conservatively, as "might have messages", and still read it:
--
--     WHERE was_deduped IS DISTINCT FROM false
--
-- not `WHERE was_deduped = true`, which would silently drop every pre-existing
-- row from the sync. The skip is only ever applied to a row we positively know
-- was created new.
ALTER TABLE platform_pushes ADD COLUMN IF NOT EXISTS was_deduped boolean;

COMMENT ON COLUMN platform_pushes.was_deduped IS
  'True = GHL matched an existing contact (so it may already have messages); '
  'false = GHL created it new (so it cannot have messages yet and the activity '
  'sync may skip it); NULL = pushed before this was tracked, treat as "might '
  'have messages" and read it.';

-- D. Per-location daily API budget -------------------------------------------
--
-- Keyed on the GHL location rather than our client row because the 200k/day
-- cap GHL enforces is per location, and three client rows share one location —
-- a per-client counter would let the three of them spend 3x the real budget.
-- Location id is text (GHL's own id), not a reference to clients, so the
-- counter survives a client row being re-pointed or deleted and so co-located
-- clients cannot each get their own row.
--
-- `day` is a date, not a rolling window: GHL's cap resets daily, and a date key
-- makes the row a natural per-day bucket that old rows can be pruned from
-- without any bookkeeping. Callers pass UTC (see the function below).
--
-- No ceiling is stored here. The ceiling (150,000, headroom under GHL's 200k)
-- is a policy the app owns; this table only counts. Putting the limit in the
-- schema would mean a migration to change it.
CREATE TABLE IF NOT EXISTS ghl_api_budget (
  ghl_location_id text    NOT NULL,
  day             date    NOT NULL,
  calls           integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ghl_location_id, day)
);

-- Atomic reserve-and-report.
--
-- Concurrency semantics, which are the entire point of this function existing
-- instead of a read-then-write in the app:
--
--  * One statement, so there is no read-modify-write window. INSERT .. ON
--    CONFLICT DO UPDATE takes a row lock on the (location, day) row; a second
--    worker hitting the same row blocks until the first commits and then
--    re-reads the committed value, so increments compose rather than clobber.
--    Two workers each reserving 100 against a row at 0 get 100 and 200 — never
--    100 and 100.
--  * The returned value is the count *after* this caller's increment, so it is
--    this caller's own high-water mark. Callers compare it to the ceiling:
--    `IF returned > CEILING THEN stop cleanly` — the job stays resumable and
--    reports status rather than burning into 429s.
--  * It is a reservation, so it must be called BEFORE the calls are made, not
--    after. Calling it afterwards means N concurrent workers all see room,
--    all spend, and the ceiling is discovered only once it has been breached.
--  * A reservation is never refunded. If the batch then fails, the calls stay
--    counted. That is deliberate: a failed GHL call still consumed quota (a
--    429 especially), and over-counting costs us a slightly early stop while
--    under-counting costs us a day of hard rate limiting.
--  * The row lock is held until the caller's transaction commits. Callers must
--    therefore not hold this open across the HTTP calls it is paying for — the
--    reservation commits, then the calls go out.
--  * `day` defaults to the UTC date rather than the server's local date so the
--    bucket boundary is stable and matches how a daily cap is reckoned; a
--    caller spanning midnight simply starts filling the next bucket.
CREATE OR REPLACE FUNCTION increment_ghl_api_budget(
  p_location_id text,
  p_calls       integer DEFAULT 1,
  p_day         date    DEFAULT (now() AT TIME ZONE 'utc')::date
)
RETURNS integer
LANGUAGE sql
AS $$
  INSERT INTO ghl_api_budget (ghl_location_id, day, calls)
  VALUES (p_location_id, p_day, p_calls)
  ON CONFLICT (ghl_location_id, day)
  DO UPDATE SET calls = ghl_api_budget.calls + EXCLUDED.calls
  RETURNING calls;
$$;

-- E. Claim serializes on the GHL location, not just the client ----------------
--
-- Replaces the definition in lib/data/push-jobs.sql. Everything there still
-- holds — read its comment for `max_concurrent`, the lease semantics of
-- `started_at`, and why only `queued` rows are ever claimed. The one change is
-- an additional exclusion.
--
-- Why: the existing predicate serializes per client row, but rate limits are
-- per GHL *location*, and three client rows share location
-- MeFEd7scikKpI44Utr8N. Two of them claiming at once means two workers at
-- concurrency 5 against a 10 req/s ceiling, which produces sustained 429s —
-- and the activity sync deletes contacts from the queue even when their fetch
-- fails, so the result is silently dropped contacts, not just a slow run.
--
-- The exclusion is deliberately narrow, so nothing that works today gets
-- stricter:
--   * both jobs must be on a GHL platform. An EmailBison push for a co-located
--     client spends no GHL quota and keeps its current per-client behaviour.
--   * the candidate's client must have a ghl_location_id. A NULL location
--     cannot collide with anything, and the `=` below never matches NULL on
--     either side anyway — the explicit IS NOT NULL is there to say so rather
--     than to leave it to three-valued logic.
--   * the running job's client must share that exact location.
-- A client with a location all to itself therefore behaves exactly as before,
-- because the only running job that can share its location is one of its own,
-- which the pre-existing per-client clause already excluded.
--
-- The join to `clients` lives inside the EXISTS rather than in the outer FROM
-- on purpose: `FOR UPDATE` applies to the base relations of the query it is
-- attached to, so joining clients up there would make every claim take row
-- locks on client rows as well. Inside an EXISTS it does not. ORDER BY
-- j.created_at and FOR UPDATE SKIP LOCKED are unchanged.
CREATE OR REPLACE FUNCTION claim_next_runnable_job(max_concurrent integer DEFAULT NULL)
RETURNS SETOF push_jobs
LANGUAGE sql
AS $$
  UPDATE push_jobs
  SET status = 'running', started_at = now()
  WHERE id = (
    SELECT j.id
    FROM push_jobs j
    WHERE j.status = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM push_jobs r
        WHERE r.status = 'running' AND r.client_id = j.client_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM push_jobs r
        JOIN clients rc ON rc.id = r.client_id
        JOIN clients jc ON jc.id = j.client_id
        WHERE r.status = 'running'
          AND j.platform IN ('ghl', 'ghl_activity')
          AND r.platform IN ('ghl', 'ghl_activity')
          AND jc.ghl_location_id IS NOT NULL
          AND rc.ghl_location_id = jc.ghl_location_id
      )
      AND (
        max_concurrent IS NULL
        OR (SELECT count(*) FROM push_jobs c WHERE c.status = 'running') < max_concurrent
      )
    ORDER BY j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$;
