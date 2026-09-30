-- Rollback for lib/data/ghl-activity.sql (GHL "Last activity").
--
-- Destructive: dropping ghl_messages discards every message we have stored,
-- and dropping the platform_pushes columns discards every computed
-- last-activity date. Both are re-derivable — a full sync rebuilds them from
-- GHL — but a full sweep of a 30k-conversation location plus one export call
-- per pushed contact is not free, so do not run this casually.
--
-- Nothing here touches the filter RPCs, because the forward migration didn't
-- either: the last-activity filter reads platform_pushes through PostgREST,
-- so removing the columns removes the filter's backing data and nothing else.
-- Any queued/running push_jobs row with platform = 'ghl_activity' becomes
-- unrunnable after this; cancel those first.

DROP INDEX IF EXISTS ghl_activity_queue_client_enqueued_idx;
DROP TABLE IF EXISTS ghl_activity_queue;

DROP TABLE IF EXISTS ghl_activity_sweeps;

DROP INDEX IF EXISTS platform_pushes_client_platform_contact_idx;
DROP INDEX IF EXISTS platform_pushes_client_platform_activity_idx;

ALTER TABLE platform_pushes DROP COLUMN IF EXISTS activity_synced_at;
ALTER TABLE platform_pushes DROP COLUMN IF EXISTS last_message_direction;
ALTER TABLE platform_pushes DROP COLUMN IF EXISTS last_message_type;
ALTER TABLE platform_pushes DROP COLUMN IF EXISTS last_activity_at;

DROP INDEX IF EXISTS ghl_messages_person_client_occurred_idx;
DROP TABLE IF EXISTS ghl_messages;
