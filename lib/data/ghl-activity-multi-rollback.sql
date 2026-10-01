-- Rollback for lib/data/ghl-activity-multi.sql.
--
-- Reverse order of the forward file (E..A), because E's claim predicate is the
-- only thing keeping co-located GHL jobs apart while the rest is undone, and
-- because A's primary key is the last thing anything still writes through.
--
-- Two of these steps can be *blocked by data written since the forward
-- migration ran*, which a rollback must not turn into a half-applied database:
--
--   * B re-adds a GLOBAL unique on ghl_message_id. If two co-located clients
--     have since stored the same message id — exactly the corruption the
--     forward change exists to prevent — that constraint cannot be re-created
--     without deleting one client's rows. This script will NOT delete them. It
--     raises a NOTICE and leaves the composite constraint in place; the
--     operator decides which rows to lose.
--   * A restores PK (client_id, ghl_contact_id). Rows belonging to targeted
--     jobs make that key non-unique. Those rows ARE deleted, because
--     ghl_activity_queue is a regenerable work list (a sweep rebuilds it) and
--     because without the job_id column they are indistinguishable from the
--     shared queue's rows anyway. In-flight targeted jobs lose their work list
--     and will report zero remaining; cancel them first.
--
-- The forward file's section C (platform_pushes.was_deduped) is dropped here
-- and that data is NOT re-derivable — GHL's `new` flag is only returned at
-- push time. Re-running the forward migration gives the column back empty, and
-- every row reverts to the conservative NULL "might have messages" treatment.

-- E. Restore the per-client-only claim predicate ------------------------------
--
-- Verbatim the definition from lib/data/push-jobs.sql, so that file remains the
-- single source of truth for the pre-change behaviour.
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

-- D. Budget counter -----------------------------------------------------------
--
-- Dropping the counter mid-day forfeits today's spend record, so the next
-- forward apply starts the location back at zero against a budget it has
-- already partly spent. Prefer to roll back outside a heavy sync window.
DROP FUNCTION IF EXISTS increment_ghl_api_budget(text, integer, date);
DROP TABLE IF EXISTS ghl_api_budget;

-- C. was_deduped --------------------------------------------------------------
ALTER TABLE platform_pushes DROP COLUMN IF EXISTS was_deduped;

-- B. Restore the global unique on ghl_message_id ------------------------------
--
-- Add-then-drop as in the forward file, so a refusal here leaves the composite
-- constraint protecting the table rather than nothing.
DO $$
DECLARE
  dupes bigint;
  idx   record;
BEGIN
  SELECT count(*) INTO dupes
  FROM (
    SELECT 1 FROM ghl_messages GROUP BY ghl_message_id HAVING count(*) > 1
  ) d;

  IF dupes > 0 THEN
    RAISE NOTICE
      'ghl_messages: % message id(s) are held by more than one client; leaving '
      'UNIQUE (ghl_message_id, client_id) in place. Resolve the duplicates by '
      'hand before restoring the global constraint.', dupes;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = 'ghl_messages'::regclass
      AND i.indisunique
      AND NOT i.indisprimary
      AND (SELECT array_agg(a.attname::text)
             FROM unnest(
                    (string_to_array(i.indkey::text, ' ')::smallint[])[1:i.indnkeyatts]
                  ) AS k(attnum)
             JOIN pg_attribute a
               ON a.attrelid = i.indrelid AND a.attnum = k.attnum) = ARRAY['ghl_message_id']
  ) THEN
    ALTER TABLE ghl_messages
      ADD CONSTRAINT ghl_messages_ghl_message_id_key UNIQUE (ghl_message_id);
  END IF;

  FOR idx IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'ghl_messages'::regclass
      AND c.contype = 'u'
      AND c.conname = 'ghl_messages_message_client_key'
  LOOP
    EXECUTE format('ALTER TABLE ghl_messages DROP CONSTRAINT %I', idx.conname);
  END LOOP;
END
$$;

-- A. Narrow the queue key back to (client_id, ghl_contact_id) -----------------
--
-- See the header: the targeted-job rows are dropped, not merged. Merging them
-- into the shared queue would hand another client's job work it never asked
-- for, and a sweep reproduces anything genuinely outstanding.
-- Guarded on the column existing so a second run of this rollback (when job_id
-- is already gone) is a no-op rather than an "column does not exist" error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'ghl_activity_queue'::regclass
      AND attname = 'job_id'
      AND NOT attisdropped
  ) THEN
    DELETE FROM ghl_activity_queue
    WHERE job_id <> '00000000-0000-0000-0000-000000000000';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ghl_activity_queue_client_enqueued_idx
  ON ghl_activity_queue (client_id, enqueued_at);

DROP INDEX IF EXISTS ghl_activity_queue_client_job_enqueued_idx;

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

  IF pk_cols IS DISTINCT FROM ARRAY['client_id', 'ghl_contact_id'] THEN
    IF pk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE ghl_activity_queue DROP CONSTRAINT %I', pk_name);
    END IF;
    ALTER TABLE ghl_activity_queue
      ADD CONSTRAINT ghl_activity_queue_pkey
      PRIMARY KEY (client_id, ghl_contact_id);
  END IF;
END
$$;

ALTER TABLE ghl_activity_queue DROP COLUMN IF EXISTS job_id;
