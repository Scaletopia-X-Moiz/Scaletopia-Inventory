-- Run once in the Supabase SQL editor (ticket #42, "GHL Push 1").
--
-- Client identity + push credentials. One row per agency client, keyed by a
-- human-readable `slug` (matches the `<CLIENT>` portion of the existing
-- GHL_<CLIENT>_API_KEY / GHL_<CLIENT>_LOCATION_ID .env vars, lowercased) so
-- the seed script and any later lookup can address a client without needing
-- its uuid. EmailBison columns are included now for schema completeness —
-- later tickets populate/push against them — but EmailBison push itself is
-- out of scope this round.
CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  ghl_api_key text,
  ghl_location_id text,
  emailbison_api_key text,
  emailbison_workspace_id text,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
