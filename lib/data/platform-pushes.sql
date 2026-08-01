-- Run once in the Supabase SQL editor (ticket #45, "GHL Push 5").
--
-- Schema layer only for GHL push-tracking: a `platform_pushes` log table
-- recording each successful push of a person to an external platform (GHL
-- now, others later — hence the generic `platform` column rather than a
-- GHL-specific table), plus the two `people` columns the push engine
-- (later ticket) flips once a push succeeds. The unique constraint on
-- (person_id, client_id, platform) lets a later "already pushed to this
-- client" check be a single indexed lookup/upsert instead of a scan.
CREATE TABLE IF NOT EXISTS platform_pushes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  platform text NOT NULL,
  platform_contact_id text,
  campaign_tag text,
  pushed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, client_id, platform)
);

CREATE INDEX IF NOT EXISTS platform_pushes_person_id_idx
  ON platform_pushes (person_id);

ALTER TABLE people ADD COLUMN IF NOT EXISTS pushed_to_ghl boolean NOT NULL DEFAULT false;
ALTER TABLE people ADD COLUMN IF NOT EXISTS pushed_to_ghl_at timestamptz;

-- Ticket #65: actor-tracking columns on platform_pushes, mirroring the
-- user_id/user_email pattern on activity_log (see supabase-auth.sql).
-- Nullable because existing rows have no actor recorded and this ticket
-- doesn't backfill them (that's tickets #2 and #3).
ALTER TABLE platform_pushes ADD COLUMN IF NOT EXISTS pushed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE platform_pushes ADD COLUMN IF NOT EXISTS pushed_by_email text;
