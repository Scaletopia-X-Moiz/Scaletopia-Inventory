-- Run in Supabase SQL editor before using the import feature.

-- Provider mappings: stores confirmed column maps per source provider
CREATE TABLE IF NOT EXISTS import_provider_mappings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  target_table text NOT NULL CHECK (target_table IN ('companies', 'people')),
  column_map jsonb NOT NULL DEFAULT '{}',
  last_used_client text,
  last_used_niche text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Import history: one row per completed push
CREATE TABLE IF NOT EXISTS import_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source_key text NOT NULL,
  target_table text NOT NULL,
  tags text[] NOT NULL,
  input_count int NOT NULL DEFAULT 0,
  deduped_count int NOT NULL DEFAULT 0,
  inserted_count int NOT NULL DEFAULT 0,
  updated_count int NOT NULL DEFAULT 0,
  failed_count int NOT NULL DEFAULT 0,
  failed_records jsonb DEFAULT '[]',
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- The history tab lists the 50 most recent runs ordered by completed_at;
-- without this index Postgres sorts the whole table (including the
-- potentially large failed_records jsonb blobs) on every request, which can
-- exceed the statement timeout as the table grows.
CREATE INDEX IF NOT EXISTS import_history_completed_at_idx ON import_history (completed_at DESC);

-- Clay push history: one row per "Push to Clay" run, updated in place as it progresses.
-- webhook_host only (never the full URL) since Clay webhook URLs embed a bearer token in the path.
CREATE TABLE IF NOT EXISTS clay_push_runs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  webhook_host text,
  filters jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  total_matched int NOT NULL DEFAULT 0,
  pushed_count int NOT NULL DEFAULT 0,
  error_count int NOT NULL DEFAULT 0,
  failed_companies jsonb NOT NULL DEFAULT '[]',
  error_message text,
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS clay_push_runs_started_at_idx ON clay_push_runs (started_at DESC);

-- Single text column holding ALL email addresses for a company (comma-separated
-- when a provider supplies more than one). Not a Postgres array by design.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email text;

-- MillionVerifier result for the company email (people already have this
-- column). Same vocabulary as people.email_status: ok | catch_all | unknown |
-- invalid | disposable. Written by the "Reverify email" buttons.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_status text;

-- Timestamp of the last successful MillionVerifier check, on both tables.
-- NULL means "never verified" — the UI shows a distinct "Not verified" badge
-- for that case rather than treating it the same as an already-checked email.
ALTER TABLE people ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- RPC: bulk company updates (appends source, overwrites tags, merges enrichment fields)
-- Enrichment fields use COALESCE so only non-null incoming values overwrite existing data.
-- custom_data is merged (||) so new keys are added without wiping existing provider data.
CREATE OR REPLACE FUNCTION import_bulk_update_companies(
  updates jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  rec jsonb;
BEGIN
  FOR rec IN SELECT * FROM jsonb_array_elements(updates) LOOP
    IF (rec->>'domain') IS NOT NULL THEN
      UPDATE companies SET
        tags = ARRAY(SELECT jsonb_array_elements_text(rec->'tags')),
        source = CASE
          WHEN source IS NULL THEN rec->>'source'
          WHEN source LIKE '%' || (rec->>'source') || '%' THEN source
          ELSE source || ',' || (rec->>'source')
        END,
        last_updated = (rec->>'last_updated')::timestamptz,
        company_name  = COALESCE(rec->>'company_name',  company_name),
        website_url   = COALESCE(rec->>'website_url',   website_url),
        linkedin_url  = COALESCE(rec->>'linkedin_url',  linkedin_url),
        industry      = COALESCE(rec->>'industry',      industry),
        city          = COALESCE(rec->>'city',          city),
        state         = COALESCE(rec->>'state',         state),
        country       = COALESCE(rec->>'country',       country),
        phone         = COALESCE(rec->>'phone',         phone),
        email         = COALESCE(rec->>'email',         email),
        description   = COALESCE(rec->>'description',   description),
        revenue       = COALESCE(rec->>'revenue',       revenue),
        employee_count = COALESCE(
          CASE WHEN rec->>'employee_count' ~ '^[0-9]+$'
            THEN (rec->>'employee_count')::int ELSE NULL END,
          employee_count
        ),
        founded_year = COALESCE(
          CASE WHEN rec->>'founded_year' ~ '^[0-9]+$'
            THEN (rec->>'founded_year')::int ELSE NULL END,
          founded_year
        ),
        custom_data = CASE
          WHEN rec->'custom_data' IS NOT NULL AND jsonb_typeof(rec->'custom_data') = 'object'
            THEN (
              SELECT jsonb_object_agg(
                key,
                CASE
                  WHEN old_val IS NOT NULL AND new_val IS NOT NULL AND old_val != new_val
                    THEN old_val || ', ' || new_val
                  WHEN new_val IS NOT NULL THEN new_val
                  ELSE old_val
                END
              )
              FROM (
                SELECT
                  COALESCE(o.key, n.key) AS key,
                  o.value #>> '{}' AS old_val,
                  n.value #>> '{}' AS new_val
                FROM jsonb_each(COALESCE(custom_data, '{}'::jsonb)) o
                FULL OUTER JOIN jsonb_each(rec->'custom_data') n ON o.key = n.key
              ) merged
            )
          ELSE custom_data
        END
      WHERE domain = rec->>'domain';
    ELSIF (rec->>'linkedin_url') IS NOT NULL THEN
      UPDATE companies SET
        tags = ARRAY(SELECT jsonb_array_elements_text(rec->'tags')),
        source = CASE
          WHEN source IS NULL THEN rec->>'source'
          WHEN source LIKE '%' || (rec->>'source') || '%' THEN source
          ELSE source || ',' || (rec->>'source')
        END,
        last_updated = (rec->>'last_updated')::timestamptz,
        company_name  = COALESCE(rec->>'company_name',  company_name),
        website_url   = COALESCE(rec->>'website_url',   website_url),
        industry      = COALESCE(rec->>'industry',      industry),
        city          = COALESCE(rec->>'city',          city),
        state         = COALESCE(rec->>'state',         state),
        country       = COALESCE(rec->>'country',       country),
        phone         = COALESCE(rec->>'phone',         phone),
        email         = COALESCE(rec->>'email',         email),
        description   = COALESCE(rec->>'description',   description),
        revenue       = COALESCE(rec->>'revenue',       revenue),
        employee_count = COALESCE(
          CASE WHEN rec->>'employee_count' ~ '^[0-9]+$'
            THEN (rec->>'employee_count')::int ELSE NULL END,
          employee_count
        ),
        founded_year = COALESCE(
          CASE WHEN rec->>'founded_year' ~ '^[0-9]+$'
            THEN (rec->>'founded_year')::int ELSE NULL END,
          founded_year
        ),
        custom_data = CASE
          WHEN rec->'custom_data' IS NOT NULL AND jsonb_typeof(rec->'custom_data') = 'object'
            THEN (
              SELECT jsonb_object_agg(
                key,
                CASE
                  WHEN old_val IS NOT NULL AND new_val IS NOT NULL AND old_val != new_val
                    THEN old_val || ', ' || new_val
                  WHEN new_val IS NOT NULL THEN new_val
                  ELSE old_val
                END
              )
              FROM (
                SELECT
                  COALESCE(o.key, n.key) AS key,
                  o.value #>> '{}' AS old_val,
                  n.value #>> '{}' AS new_val
                FROM jsonb_each(COALESCE(custom_data, '{}'::jsonb)) o
                FULL OUTER JOIN jsonb_each(rec->'custom_data') n ON o.key = n.key
              ) merged
            )
          ELSE custom_data
        END
      WHERE linkedin_url = rec->>'linkedin_url' AND domain IS NULL;
    END IF;
  END LOOP;
END;
$$;

-- Seed built-in provider presets (idempotent)
INSERT INTO import_provider_mappings (source_key, display_name, target_table, column_map)
VALUES
  ('aiark', 'AI Ark', 'companies', '{"Company Name":"company_name","Domain":"domain","LinkedIn URL":"linkedin_url","Website":"website_url","Industry":"industry","Employee Count":"employee_count","City":"city","State":"state","Country":"country","Phone":"phone","Description":"description"}'),
  ('apollo', 'Apollo', 'companies', '{"Company":"company_name","Company Name":"company_name","Website":"website_url","Company LinkedIn Url":"linkedin_url","# Employees":"employee_count","Industry":"industry","City":"city","State":"state","Country":"country","Corporate Phone":"phone"}'),
  ('blitz', 'Blitz', 'companies', '{"Company Name":"company_name","Domain":"domain","LinkedIn":"linkedin_url","Website":"website_url","Industry":"industry","Employees":"employee_count","City":"city","State":"state","Country":"country","Phone":"phone"}'),
  ('google-maps', 'Google Maps', 'companies', '{"Title":"company_name","Website":"website_url","Phone":"phone","City":"city","State":"state","Country":"country"}'),
  ('store-leads', 'Store Leads', 'companies', '{"domain":"domain","merchant_name":"company_name","linkedin_url":"linkedin_url","city":"city","state":"state","country_code":"country","description":"description","emails":"email","phones":"phone","employee_count":"employee_count","technologies":"technologies","estimated_yearly_sales":"revenue","meta_keywords":"keywords","categories":"custom_data","tiktok":"custom_data"}'),
  ('leadfox', 'LeadFox', 'companies', '{"Website":"domain","Name":"company_name","Description":"description","Shop Category":"industry","Email":"email","Phone Number":"phone","City":"city","State":"state","Country":"country","Est. Monthly Sales":"revenue","Technology Used":"technologies","Keywords":"keywords","LinkedIn":"linkedin_url","Est. Products Sold":"custom_data","Platform":"custom_data","Plan":"custom_data","Theme":"custom_data","Installed Apps":"custom_data","Est Monthly Page Views":"custom_data","Est Monthly Visits":"custom_data","Shipping Partners":"custom_data","Facebook":"custom_data","Instagram":"custom_data","Twitter":"custom_data","Twitter Followers":"custom_data","Twitter Posts":"custom_data","YouTube":"custom_data","YouTube Followers":"custom_data","Pinterest":"custom_data","Pinterest Followers":"custom_data","Pinterest Posts":"custom_data","Tiktok":"custom_data","Tiktok Followers":"custom_data","Lang":"custom_data","Enrichment":"ignore"}'),
  ('builtwith', 'BuiltWith', 'companies', '{"Domain":"domain","Website":"website_url","Country":"country"}'),
  ('clutch', 'Clutch', 'companies', '{"Company":"company_name","Website":"website_url","Location":"city","Employees":"employee_count","Description":"description"}'),
  ('crunchbase', 'Crunchbase', 'companies', '{"Organization Name":"company_name","Website":"website_url","LinkedIn":"linkedin_url","Number of Employees":"employee_count","Industry":"industry","City":"city","Country":"country","Founded Year":"founded_year","Description":"description"}'),
  ('yelp', 'Yelp', 'companies', '{"Business Name":"company_name","Website":"website_url","Phone":"phone","City":"city","State":"state","Country":"country"}'),
  ('salesnav', 'Sales Navigator', 'people', '{"Full Name":"full_name","First Name":"first_name","Last Name":"last_name","Job Title":"job_title","Email":"email","LinkedIn Profile URL":"linkedin_url","Company":"company_name","City":"city","Country":"country"}'),
  ('external-scraper', 'External Scraper', 'people', '{"Company Name":"company_name","Domain":"domain","First Name":"first_name","Last Name":"last_name","Job Title":"job_title","Person Linkedin Url":"linkedin_url","Mobile Phone":"phone","Other Phone":"custom_data","First Name_1":"ignore","Last Name_1":"ignore","Title":"ignore","Person Linkedin Url_1":"ignore","City":"city","State":"state","Country":"country","Email":"email","Company Name_1":"ignore","Website":"ignore","Industry":"ignore","# Employees":"ignore","Annual Revenue":"ignore","Total Funding":"ignore","Company Phone":"ignore","Company Linkedin Url":"ignore","Company Street":"ignore","Company City":"ignore","Company Postal Code":"ignore","Company State":"ignore","Company Country":"ignore","Company Founded Year":"ignore"}'),
  ('manual-csv', 'Manual CSV', 'companies', '{}')
ON CONFLICT (source_key) DO NOTHING;

-- RPC: bulk people updates
--
-- BUG A FIX (must be re-run manually in the Supabase SQL editor — this file is
-- applied by hand, not by an automatic migration runner). The old WHERE matched
-- linkedin OR email in a single statement, so one incoming record carrying BOTH
-- a linkedin and an email would overwrite every person sharing EITHER value —
-- e.g. a generic/shared email (info@acme.com) used by several contacts got all
-- their rows clobbered from one import record. The match is now deterministic
-- and single-row-intended: linkedin_url is the identity, and email is only used
-- as a fallback when the record has no linkedin (see CASE in the WHERE below).
CREATE OR REPLACE FUNCTION import_bulk_update_people(
  updates jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  rec jsonb;
BEGIN
  FOR rec IN SELECT * FROM jsonb_array_elements(updates) LOOP
    IF (rec->>'linkedin_url') IS NOT NULL OR (rec->>'email') IS NOT NULL THEN
      UPDATE people SET
        -- Only overwrite company_id when this row resolved to one; a lookup
        -- miss (no matching company for the row's domain) must not unlink
        -- an existing match.
        company_id = COALESCE((rec->>'company_id')::uuid, company_id),
        tags = ARRAY(SELECT jsonb_array_elements_text(rec->'tags')),
        source = CASE
          WHEN source IS NULL THEN rec->>'source'
          WHEN source LIKE '%' || (rec->>'source') || '%' THEN source
          ELSE source || ',' || (rec->>'source')
        END,
        last_updated = (rec->>'last_updated')::timestamptz,
        custom_data = CASE
          WHEN rec->'custom_data' IS NOT NULL AND jsonb_typeof(rec->'custom_data') = 'object'
            THEN (
              SELECT jsonb_object_agg(
                key,
                CASE
                  WHEN old_val IS NOT NULL AND new_val IS NOT NULL AND old_val != new_val
                    THEN old_val || ', ' || new_val
                  WHEN new_val IS NOT NULL THEN new_val
                  ELSE old_val
                END
              )
              FROM (
                SELECT
                  COALESCE(o.key, n.key) AS key,
                  o.value #>> '{}' AS old_val,
                  n.value #>> '{}' AS new_val
                FROM jsonb_each(COALESCE(custom_data, '{}'::jsonb)) o
                FULL OUTER JOIN jsonb_each(rec->'custom_data') n ON o.key = n.key
              ) merged
            )
          ELSE custom_data
        END
      WHERE
        -- Deterministic precedence: prefer linkedin_url as the identity and
        -- only fall back to email when linkedin is absent from the record. This
        -- guarantees a record with a linkedin can never match unrelated people
        -- by a shared email.
        CASE
          WHEN rec->>'linkedin_url' IS NOT NULL THEN linkedin_url = rec->>'linkedin_url'
          WHEN rec->>'email' IS NOT NULL THEN lower(email) = lower(rec->>'email')
          ELSE false
        END;
    END IF;
  END LOOP;
END;
$$;

-- ClearoutPhone result for people/companies phone numbers, written by the
-- "Reverify" phone buttons. `phone_status` is the verdict (valid | invalid |
-- whatever else ClearoutPhone returns — pass-through, not a closed enum).
-- `people.phone_type` already existed (mobile/landline/toll_free/voip line-type
-- classification) and is intentionally left alone as a DIFFERENT concept from
-- phone_status; companies had no phone_type column at all, so it's added here.
ALTER TABLE people ADD COLUMN IF NOT EXISTS phone_status text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone_status text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone_type text;

-- Cleaned/simplified brand name for companies, written by the "Clean Names"
-- bulk action (OpenRouter / gemini-2.5-flash-lite). company_name stays the raw
-- source; brand_name is nullable and only populated once a row is cleaned.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_name text;
