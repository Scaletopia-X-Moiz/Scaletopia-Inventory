-- GHL "Last activity" (docs/features/ghl-last-activity/handoff.md).
-- Applied to swfykpknnfunpapzoudn on 2026-09-30 as migration "ghl_activity".
-- Idempotent (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so
-- re-running is safe. Rollback: lib/data/ghl-activity-rollback.sql.
--
-- Four pieces:
--   1. `ghl_messages`     — the per-contact message history the click-through
--                           drawer renders, and the source of truth the
--                           denormalized date below is recomputed from.
--   2. `platform_pushes`  — four denormalized columns so the People table and
--                           its filter never have to touch ghl_messages.
--   3. `ghl_activity_sweeps` — the per-client high-water mark that makes the
--                           sync incremental (see §14 of the handoff).
--   4. `ghl_activity_queue`  — the durable work list a sweep produces, so a
--                           multi-tick job resumes without stuffing tens of
--                           thousands of contact ids into push_jobs.cursor.
--
-- Deliberately NOT here: any change to the six filter RPCs. The last-activity
-- filter resolves an id set straight off platform_pushes through PostgREST
-- (lib/data/ghl-activity.ts), exactly like the pushJobId filter does off
-- push_job_records — see the handoff's §14.5 for why, and
-- lib/data/ticket-25-esp-filter.sql:23-31 for the 60x regression that made
-- touching those functions a last resort.

-- 1. Message history ---------------------------------------------------------
--
-- One row per GHL message we have ever seen for a (person, client). Keyed on
-- `ghl_message_id` (GHL's own id) so a re-sync of a contact's full export —
-- which is what every sync does, since the export endpoint has no incremental
-- mode — upserts in place instead of duplicating history.
--
-- Activity events (TYPE_NO_SHOW / TYPE_ACTIVITY_* / TYPE_SYSTEM_*) are NOT
-- stored: the GHL UI ignores them for Last activity (handoff §12.1) and they
-- carry no body worth rendering. Filtering at write time keeps the table the
-- exact set of rows both the date and the drawer are computed from, so the two
-- can never disagree.
--
-- `body` is stripped to plain text and capped at 4,000 characters by the app
-- (lib/ghl/activity-rules.ts). Rationale: an HTML email body runs to hundreds
-- of KB, and this column exists to render a readable preview in a drawer, not
-- to be an email archive. 4,000 is comfortably past the point where the drawer
-- truncates visually, and keeps a 200-message contact's history well under a
-- megabyte. `raw` keeps the untouched message object for anything the drawer
-- doesn't model yet (attachments, meta, altId); it is the escape hatch that
-- makes the capped body safe.
CREATE TABLE IF NOT EXISTS ghl_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL REFERENCES clients(id),
  ghl_message_id  text NOT NULL UNIQUE,
  conversation_id text,
  occurred_at     timestamptz NOT NULL,  -- the message's own dateAdded (handoff §13.3)
  direction       text,                  -- "inbound" | "outbound" | null
  message_type    text,                  -- e.g. TYPE_SMS, TYPE_EMAIL, TYPE_CALL
  body            text,                  -- plain text, capped (see above)
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The drawer's only query: newest-first history for one (person, client).
CREATE INDEX IF NOT EXISTS ghl_messages_person_client_occurred_idx
  ON ghl_messages (person_id, client_id, occurred_at DESC);

-- 2. Denormalized last activity on platform_pushes ---------------------------
--
-- platform_pushes is already unique on (person_id, client_id, platform), i.e.
-- exactly the grain a last-activity value has, and it already carries the
-- `platform_contact_id` the sync reads. `last_activity_at` is
-- max(occurred_at) over that person+client's ghl_messages rows, recomputed on
-- every sync; NULL means "no qualifying message" and renders blank.
ALTER TABLE platform_pushes ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
ALTER TABLE platform_pushes ADD COLUMN IF NOT EXISTS last_message_type text;
ALTER TABLE platform_pushes ADD COLUMN IF NOT EXISTS last_message_direction text;
-- When we last successfully read this contact's messages. NULL = never synced,
-- which is what makes a contact "cold" to the incremental sweep (a deduped
-- push can land on a GHL contact whose only conversation predates the sweep's
-- high-water mark, so a cold contact always gets one direct export call).
ALTER TABLE platform_pushes ADD COLUMN IF NOT EXISTS activity_synced_at timestamptz;

-- Backs the last-activity filter's id-set resolution (client + platform scoped,
-- then a range/NULL test on the date). The existing
-- platform_pushes_client_platform_person_idx leads with the same two columns
-- but has person_id third, so a date range still has to visit every pushed row;
-- this one puts the date where the range can be satisfied in the index.
CREATE INDEX IF NOT EXISTS platform_pushes_client_platform_activity_idx
  ON platform_pushes (client_id, platform, last_activity_at);

-- Backs the sweep's "which of these GHL contact ids are ours?" lookup, and the
-- cold-contact scan (activity_synced_at IS NULL). platform_contact_id is not
-- unique — the same GHL contact can back several of our people after a dedupe.
CREATE INDEX IF NOT EXISTS platform_pushes_client_platform_contact_idx
  ON platform_pushes (client_id, platform, platform_contact_id);

-- 3. Per-client sweep high-water mark ----------------------------------------
--
-- `conversations/search?sortBy=last_message_date&sort=desc` returns the
-- location's conversations newest-activity-first. Any conversation whose
-- activity moved since the last sweep sorts above this mark, so a sweep can
-- stop the moment it pages past it — which is the whole optimisation (handoff
-- §14.2). Stored as epoch ms because that is both what GHL returns and what
-- the `startAfterDate` cursor takes, so no precision is lost round-tripping.
--
-- `full_sweep_completed_at` records that we have at least once walked the
-- location end-to-end. Until that happens the sweep cannot stop early, because
-- there is no mark below which "nothing changed" is a safe assumption.
CREATE TABLE IF NOT EXISTS ghl_activity_sweeps (
  client_id                uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  last_message_date_ms     bigint,
  full_sweep_completed_at  timestamptz,
  last_swept_at            timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- 4. Durable per-sweep work list ---------------------------------------------
--
-- A sweep can identify tens of thousands of contacts to re-read; push_jobs.cursor
-- is a jsonb column on a row that is rewritten on every progress tick, so
-- carrying that list in it would mean rewriting a ~750KB value every few
-- seconds. Instead the sweep writes rows here and the fetch phase drains them,
-- deleting each batch as it completes — so a crashed invocation resumes
-- exactly where it stopped without any cursor arithmetic.
--
-- `last_message_date` is the value the sweep observed, carried through so the
-- fetch phase can skip a contact whose stored last_activity_at already matches
-- (the sweep sees every conversation in its window, including ones we are
-- already up to date on).
CREATE TABLE IF NOT EXISTS ghl_activity_queue (
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ghl_contact_id    text NOT NULL,
  last_message_date timestamptz,
  enqueued_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, ghl_contact_id)
);

CREATE INDEX IF NOT EXISTS ghl_activity_queue_client_enqueued_idx
  ON ghl_activity_queue (client_id, enqueued_at);
