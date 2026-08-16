-- Run once in the Supabase SQL editor (company-native EmailBison push,
-- superseding ADR 0003's "no company-level lead" decision — see
-- docs/adr/0005-company-native-emailbison-push.md). Local DATABASE_URL's
-- password is stale, so this can't be applied via a migration runner — see
-- the identical note atop push-jobs.sql.
--
-- Before this, a Companies-table EmailBison push resolved each matching
-- Company to its linked People and pushed those People as leads
-- (getPeopleForEmailBisonByCompanyFilters). Now the Company itself is pushed
-- as its own lead — company = brand/company name, email = the company's own
-- `companies.email` — mirroring exactly how a Person is pushed. That needs
-- three things: (1) platform_pushes can key a row on a company instead of a
-- person, for company-side dedup; (2) companies gets its own
-- pushed_to_emailbison flag pair, mirroring people's; (3) push_job_records
-- (the per-run "who did this job touch" tag table) can tag a company id
-- instead of a person id.
--
-- Non-partial unique indexes throughout: Postgres treats NULLs as distinct
-- values, so a People row (company_id IS NULL) never collides with another
-- People row on a (company_id, ...) unique index, and a Companies row
-- (person_id IS NULL) never collides on a (person_id, ...) one — a partial
-- index isn't needed for that, and would break PostgREST's onConflict
-- inference (it can only infer a full, not a partial, unique index).

-- platform_pushes: allow a company-level push row (company_id set, person_id null).
ALTER TABLE platform_pushes ALTER COLUMN person_id DROP NOT NULL;
ALTER TABLE platform_pushes ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
-- exactly one of person_id / company_id per row
ALTER TABLE platform_pushes ADD CONSTRAINT platform_pushes_entity_ck
  CHECK ((person_id IS NOT NULL) <> (company_id IS NOT NULL)) NOT VALID;
ALTER TABLE platform_pushes VALIDATE CONSTRAINT platform_pushes_entity_ck;
-- company dedup, mirroring UNIQUE(person_id, client_id, platform); full (non-partial) index so
-- onConflict can infer it. People rows (company_id NULL) are all distinct → coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS platform_pushes_company_client_platform_uq
  ON platform_pushes (company_id, client_id, platform);
CREATE INDEX IF NOT EXISTS platform_pushes_company_id_idx ON platform_pushes (company_id);
CREATE INDEX IF NOT EXISTS platform_pushes_client_platform_company_idx
  ON platform_pushes (client_id, platform, company_id);

-- companies: the pushed flag pair, mirroring people.pushed_to_emailbison / _at.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pushed_to_emailbison boolean NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pushed_to_emailbison_at timestamptz;

-- push_job_records: allow a company-tagged record. The existing PK (push_job_id, person_id) forces
-- person_id NOT NULL, so drop it and replace with two full unique indexes.
ALTER TABLE push_job_records DROP CONSTRAINT push_job_records_pkey;
ALTER TABLE push_job_records ALTER COLUMN person_id DROP NOT NULL;
ALTER TABLE push_job_records ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
CREATE UNIQUE INDEX IF NOT EXISTS push_job_records_job_person_uq
  ON push_job_records (push_job_id, person_id);
CREATE UNIQUE INDEX IF NOT EXISTS push_job_records_job_company_uq
  ON push_job_records (push_job_id, company_id);
CREATE INDEX IF NOT EXISTS push_job_records_company_idx ON push_job_records (company_id);
