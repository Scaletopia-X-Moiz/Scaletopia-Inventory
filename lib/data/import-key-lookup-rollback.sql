-- ROLLBACK for lib/data/import-key-lookup.sql (+ the import_bulk_update_*
-- changes in lib/import/migrations.sql), applied 2026-09-30.
-- Order: revert the app code first (git revert of lib/import/push.ts) — the old
-- push.ts does not call the new RPCs, so dropping them afterwards is safe.
--
-- 1) Restore the ORIGINAL bulk-update RPCs (verbatim pg_get_functiondef output
--    captured before the change). CREATE OR REPLACE keeps grants; the original
--    had no search_path setting, so reset it explicitly afterwards.
CREATE OR REPLACE FUNCTION public.import_bulk_update_companies(updates jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.import_bulk_update_people(updates jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

ALTER FUNCTION public.import_bulk_update_companies(jsonb) RESET search_path;
ALTER FUNCTION public.import_bulk_update_people(jsonb) RESET search_path;

-- 2) Drop the lookup RPCs.
DROP FUNCTION IF EXISTS public.import_match_companies(text[], text[]);
DROP FUNCTION IF EXISTS public.import_match_people(text[], text[]);
DROP FUNCTION IF EXISTS public.import_companies_by_domain(text[]);
DROP FUNCTION IF EXISTS public.import_known_clients();

-- 3) Indexes (run one at a time, outside a transaction). Dropping the new
--    indexes is optional — they are harmless to keep.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_companies_domain ON public.companies USING btree (domain);
DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_linkedin_canon;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_people_linkedin_canon;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_people_email_lower;
