-- Run once in the Supabase SQL editor (ticket #114, "Per-client mapping
-- persistence").
--
-- Remembers the last field mapping chosen for a given (client, platform)
-- push, so the mapping/options step can pre-load it as the next push's
-- starting point instead of the pure auto-mapping default — same pattern as
-- Import's per-sourceKey saved mapping (import_provider_mappings, see
-- app/api/import/mappings/route.ts). `platform` distinguishes not just GHL
-- vs EmailBison but People vs Companies within EmailBison too ("ghl",
-- "emailbison_people", "emailbison_companies"), since the two entities map
-- an entirely different field set even though they share
-- EmailBisonStandardFieldMapping's shape. `mapping` is stored opaque
-- (jsonb) — its shape is whatever that platform's push button currently
-- sends, read back verbatim as the pre-load starting point.
CREATE TABLE IF NOT EXISTS push_field_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  platform text NOT NULL,
  mapping jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, platform)
);
