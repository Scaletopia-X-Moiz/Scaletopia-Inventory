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

-- SQL port of lib/data/niche.ts's nichesFromTags, needed only by the people-
-- propagation step inside import_bulk_update_companies below: that RPC has no
-- access to TypeScript, so the tag-parsing fallback (used when a company has
-- no niche of its own) is duplicated here. Mirrors the TS function exactly:
-- a keyed `niche:value` tag wins outright; otherwise dates, known prefixes,
-- and known client names are stripped and whatever remains is the niche set.
-- If lib/data/niche.ts's nichesFromTags ever changes, this must change too.
CREATE OR REPLACE FUNCTION niche_tokens_from_tags(p_tags text[], p_known_clients text[])
RETURNS text[] LANGUAGE sql STABLE AS $$
  -- WITH ORDINALITY + GROUP BY MIN(ord) dedupes while preserving each value's
  -- FIRST occurrence order, matching `Array.from(new Set(...))` in TS exactly
  -- (plain `SELECT DISTINCT` does not preserve input order in Postgres).
  WITH keyed AS (
    SELECT trim(substring(t from position(':' in t) + 1)) AS niche, min(ord) AS first_ord
    FROM unnest(p_tags) WITH ORDINALITY AS u(t, ord)
    WHERE lower(t) LIKE 'niche:%'
    GROUP BY 1
  ),
  keyed_filtered AS (
    SELECT niche, first_ord FROM keyed WHERE niche <> ''
  )
  SELECT
    CASE
      WHEN (SELECT count(*) FROM keyed_filtered) > 0
        THEN ARRAY(SELECT niche FROM keyed_filtered ORDER BY first_ord)
      ELSE ARRAY(
        SELECT t FROM (
          SELECT t, min(ord) AS first_ord
          FROM unnest(p_tags) WITH ORDINALITY AS u(t, ord)
          WHERE trim(t) !~ '^\d{4}-\d{2}-\d{2}$'
            AND NOT (
              lower(trim(t)) LIKE 'campaign:%' OR lower(trim(t)) LIKE 'geo:%' OR
              lower(trim(t)) LIKE 'imported:%' OR lower(trim(t)) LIKE 'source:%'
            )
            AND NOT (lower(trim(t)) = ANY(COALESCE(p_known_clients, '{}'::text[])))
          GROUP BY t
        ) dedup
        ORDER BY first_ord
      )
    END
$$;

-- RPC: bulk company updates (appends source, overwrites tags, merges enrichment fields)
-- Enrichment fields use COALESCE so only non-null incoming values overwrite existing data.
-- custom_data is merged (||) so new keys are added without wiping existing provider data.
--
-- CANONICAL COLUMNS UPDATE (must be re-run in the Supabase SQL editor after
-- lib/data/canonical-columns.sql has added country_id/industry_id/
-- source_tokens to companies — this CREATE OR REPLACE now also maintains
-- them; see docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md).
--
-- TICKET #83 (must be re-run again): companies.client/niche are COALESCEd
-- from rec->>'client'/rec->>'niche' in both branches below, same semantics as
-- the other enrichment fields. push.ts's bulkUpdate now always supplies these
-- (they're this whole push's [client, niche] tags, not a per-record raw
-- field) — previously this RPC never wrote them, so an update (unlike a fresh
-- insert) silently left client/niche null/stale on an existing company row.
--
-- PEOPLE PROPAGATION (must be re-run again after lib/data/people-canonical-columns.sql
-- has added industry_id/employee_count/company_linkedin_url/niche_tokens to
-- people — ticket "Company updates propagate canonical fields to linked
-- people"). Every UPDATE ... companies branch below is immediately followed by
-- a bulk, indexed `UPDATE people ... WHERE company_id = ...` so a company
-- enrichment that lands after a person's own last import doesn't leave that
-- person's copies silently stale. Only industry_id/employee_count/
-- company_linkedin_url/niche_tokens are pushed — country_id/source_tokens on
-- people come from the person's OWN country/source, not the company's, so
-- they're left untouched here. niche_tokens follows the same precedence as
-- push.ts: the company's own niche wins when set, otherwise fall back to each
-- linked person's existing tag-parsed niche_tokens (already computed at their
-- own last import/backfill) rather than recomputing from tags here, since this
-- RPC has no access to lib/data/niche.ts's nichesFromTags.
CREATE OR REPLACE FUNCTION import_bulk_update_companies(
  updates jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  rec jsonb;
  updated_company_id uuid;
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
        client        = COALESCE(rec->>'client',        client),
        niche         = COALESCE(rec->>'niche',         niche),
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
        -- Canonical columns (docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md).
        -- country_id/industry_id follow the same COALESCE-if-supplied
        -- semantics as the raw fields above (push.ts only includes them when
        -- the record supplies a new raw value). source_tokens is a set
        -- union, not an overwrite, because `source` itself is appended to
        -- (not replaced) by the CASE below — new_source_tokens carries just
        -- this record's own canonical token(s).
        country_id = COALESCE(rec->>'country_id', country_id),
        industry_id = COALESCE(rec->>'industry_id', industry_id),
        source_tokens = ARRAY(
          SELECT DISTINCT unnest(
            COALESCE(source_tokens, '{}'::text[]) ||
            COALESCE(ARRAY(SELECT jsonb_array_elements_text(rec->'new_source_tokens')), '{}'::text[])
          )
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
      WHERE domain = rec->>'domain'
      RETURNING id INTO updated_company_id;

      IF updated_company_id IS NOT NULL THEN
        UPDATE people p SET
          industry_id = c.industry_id,
          employee_count = c.employee_count,
          company_linkedin_url = c.linkedin_url,
          niche_tokens = CASE
            WHEN c.niche IS NOT NULL AND c.niche <> '' THEN ARRAY[c.niche]
            ELSE niche_tokens_from_tags(p.tags, (
              SELECT array_agg(DISTINCT lower(trim(cl.client)))
              FROM companies cl WHERE cl.client IS NOT NULL AND trim(cl.client) <> ''
            ))
          END
        FROM companies c
        WHERE p.company_id = c.id AND c.id = updated_company_id;
      END IF;
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
        client        = COALESCE(rec->>'client',        client),
        niche         = COALESCE(rec->>'niche',         niche),
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
        -- Canonical columns (docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md).
        -- country_id/industry_id follow the same COALESCE-if-supplied
        -- semantics as the raw fields above (push.ts only includes them when
        -- the record supplies a new raw value). source_tokens is a set
        -- union, not an overwrite, because `source` itself is appended to
        -- (not replaced) by the CASE below — new_source_tokens carries just
        -- this record's own canonical token(s).
        country_id = COALESCE(rec->>'country_id', country_id),
        industry_id = COALESCE(rec->>'industry_id', industry_id),
        source_tokens = ARRAY(
          SELECT DISTINCT unnest(
            COALESCE(source_tokens, '{}'::text[]) ||
            COALESCE(ARRAY(SELECT jsonb_array_elements_text(rec->'new_source_tokens')), '{}'::text[])
          )
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
      WHERE linkedin_url = rec->>'linkedin_url' AND domain IS NULL
      RETURNING id INTO updated_company_id;

      IF updated_company_id IS NOT NULL THEN
        UPDATE people p SET
          industry_id = c.industry_id,
          employee_count = c.employee_count,
          company_linkedin_url = c.linkedin_url,
          niche_tokens = CASE
            WHEN c.niche IS NOT NULL AND c.niche <> '' THEN ARRAY[c.niche]
            ELSE niche_tokens_from_tags(p.tags, (
              SELECT array_agg(DISTINCT lower(trim(cl.client)))
              FROM companies cl WHERE cl.client IS NOT NULL AND trim(cl.client) <> ''
            ))
          END
        FROM companies c
        WHERE p.company_id = c.id AND c.id = updated_company_id;
      END IF;
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
--
-- CANONICAL COLUMNS (must be re-run after lib/data/people-canonical-columns.sql
-- has added industry_id/employee_count/company_linkedin_url/niche_tokens to
-- people — ticket "Import: people writes populate the new canonical
-- columns"). country_id is deliberately NOT touched here: the update path
-- never rewrites a person's own raw `country`, so re-deriving country_id here
-- would desync it from that unchanged raw value — it's only ever (re)computed
-- on insert/backfill. source_tokens follows the same append-not-overwrite
-- semantics as `source` above. industry_id/employee_count/
-- company_linkedin_url/niche_tokens are COALESCEd against push.ts's payload,
-- which only includes them when this update actually resolved a company_id
-- (lib/import/push.ts) — a lookup miss must leave the prior linked company's
-- values in place, same as company_id itself.
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
        source_tokens = ARRAY(
          SELECT DISTINCT unnest(
            COALESCE(source_tokens, '{}'::text[]) ||
            COALESCE(ARRAY(SELECT jsonb_array_elements_text(rec->'new_source_tokens')), '{}'::text[])
          )
        ),
        industry_id = COALESCE(rec->>'industry_id', industry_id),
        employee_count = COALESCE(
          CASE WHEN rec->>'employee_count' ~ '^[0-9]+$'
            THEN (rec->>'employee_count')::int ELSE NULL END,
          employee_count
        ),
        company_linkedin_url = COALESCE(rec->>'company_linkedin_url', company_linkedin_url),
        niche_tokens = CASE
          WHEN rec->'niche_tokens' IS NOT NULL
            THEN ARRAY(SELECT jsonb_array_elements_text(rec->'niche_tokens'))
          ELSE niche_tokens
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
