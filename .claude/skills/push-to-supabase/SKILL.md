---
name: push-to-supabase
description: Push companies or people records into Supabase Data Inventory with mandatory source tags. Uses pre-flight schema check + bulk existing-records query + smart split (insert NEW vs bulk-SQL-UPDATE existing). Avoids the batch-cascade-failure + partial-unique-constraint + slow-PATCH problems discovered 2026-04-24.
user_invocable: true
---

# Push to Supabase Data Inventory

Generic skill for pushing company or people records from any provider (AI-Ark, Blitz, Apollo-scraper CSV, Google Maps, etc.) into Supabase `companies` or `people` tables. Enforces source tagging and uses a **pre-flight-split strategy** (bulk query existing → partition → insert new + bulk-SQL-UPDATE existing) to avoid the slow-per-record + batch-cascade failure modes.

**Direction note**: This is `push-to-supabase` (somewhere → Supabase). The existing `supabase-push` skill is the opposite direction (Supabase → Clay webhook). Don't confuse them.

## MANDATORY Pre-flight Check (do this FIRST, every push)

Before any push, query Supabase's schema to learn the actual unique constraints + indexes on the target table. The dedupe key in your batch MUST match the DB's unique constraint key, otherwise records will fail-cascade on insert.

```python
# Query constraints + indexes
q = """
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = '{table}' AND indexdef LIKE '%UNIQUE%'
"""
```

**Known 2026-04-24 Supabase schema:**
- `companies.domain` has PARTIAL unique index (`WHERE domain IS NOT NULL`)
- `companies.linkedin_url` has NO unique constraint
- **Therefore**: dedupe your in-memory batch by DOMAIN (not linkedin_url), otherwise same-domain-different-LI-URL records collide at DB level.
- For records with null domain: they ALL insert freely (partial index excludes them). Dedupe by linkedin_url for these.

**For partial unique constraints (like `WHERE x IS NOT NULL`)**, PostgREST `on_conflict=x` returns 42P10 "no unique or exclusion constraint matching". Don't use `on_conflict` with partial constraints. Use pre-flight query + split strategy instead.

## Input

1. **Records**: List of dicts (field-mapped) OR JSONL/CSV path
2. **Target table**: `companies` or `people`
3. **Source**: Provider identifier — canonical (see below). Goes in the `source` column ONLY, not in tags.
4. **Tags (3 values, no prefixes)**: `[client, niche, date]` — e.g., `["kynship", "dtc-beauty", "2026-04-24"]`. Date is push date in `YYYY-MM-DD`. NO source tags, NO campaign tags, NO geo tags, NO approach tags.
5. **Dedupe key**: Match to actual DB unique constraint (check schema first!)

## What To Do

### Step 1: Validate Inputs

**Source tag must be from canonical set:**
- `aiark`, `blitz`, `apollo`, `google-maps`, `store-leads`, `builtwith`, `clutch`, `crunchbase`, `yelp`, `salesnav`, `apollo`, `manual-csv`

If unknown provider, ASK — don't invent.

**Required fields for `companies`:**
- At least one of: `domain`, `linkedin_url`, `company_name`
- Plus: `source`, `client`, `niche`, `tags`, `last_updated`

**Required fields for `people`:**
- `linkedin_url`
- `full_name`
- Plus: `source`, `title`, `tags`, `last_updated`

### Step 2: Normalize + Dedupe In-Memory

**Domains**: lowercase, strip `www.`, strip protocol, strip trailing `/`
**LinkedIn URLs**: lowercase, `https://www.linkedin.com/company/{slug}`, strip `?query` + trailing `/`

**CRITICAL — Dedupe in order matching DB unique constraint:**
- For `companies`: dedupe by **DOMAIN** primary (DB has unique domain). Null-domain records fall back to linkedin_url.
- For `people`: dedupe by linkedin_url.

```python
# For companies:
by_dom = {}; null_dom_by_li = {}
for r in records:
    d = r.get("domain"); li = r.get("linkedin_url")
    if d:
        # Merge into existing entry if we've seen this domain
        if d in by_dom:
            merge_record(by_dom[d], r)
        else:
            by_dom[d] = r
    elif li:
        if li in null_dom_by_li:
            merge_record(null_dom_by_li[li], r)
        else:
            null_dom_by_li[li] = r
deduped = list(by_dom.values()) + list(null_dom_by_li.values())
```

### Step 3: Scrub Junk Domains

Drop or null social/placeholder domains (facebook.com, yelp.com, wix.com, etc.). Don't drop the record — just null the domain. Record can still be stored via LinkedIn URL.

### Step 4: Filter Hard-Excluded Domains

User-provided exclusion list (existing clients, known-bad brands). DROP matching records entirely.

### Step 5: Pre-flight Query — Find Which Records Already Exist in DB

**Single bulk query for ALL domains + linkedin_urls at once, batched by 2000 per query:**

```python
# Via Supabase Management API SQL for efficiency
def esc_arr(vals):
    return "ARRAY[" + ",".join("'" + v.replace("'","''") + "'" for v in vals) + "]"

existing_doms = set()
for i in range(0, len(all_domains), 2000):
    batch = all_domains[i:i+2000]
    for row in sql_query(f"SELECT domain FROM companies WHERE domain = ANY({esc_arr(batch)})"):
        existing_doms.add(row["domain"])

existing_urls = set()
for i in range(0, len(all_linkedin), 2000):
    batch = all_linkedin[i:i+2000]
    for row in sql_query(f"SELECT linkedin_url FROM companies WHERE linkedin_url = ANY({esc_arr(batch)})"):
        if row["linkedin_url"]: existing_urls.add(row["linkedin_url"])
```

~5-30 seconds for tens of thousands of identifiers. Do NOT query per-record.

### Step 6: Partition into INSERT vs UPDATE

```python
to_insert = []
to_update_ids = []
for r in deduped:
    d = r.get("domain"); li = r.get("linkedin_url")
    if (d and d in existing_doms) or (li and li in existing_urls):
        to_update_ids.append(r)  # already in DB; will append tags via SQL
    else:
        to_insert.append(r)      # new, insert
```

### Step 7: Bulk INSERT new records

**Batch of 100 via REST (NO `on_conflict` flag for partial constraints)**. If a batch returns non-2xx, retry ONLY that batch one-by-one to isolate the truly-conflicting record. Do NOT count the whole batch as conflicts — other 99 records are valid.

```python
for i in range(0, len(to_insert), 100):
    batch = to_insert[i:i+100]
    r = post_batch(batch)
    if r.status_code not in (200, 201, 204):
        # Retry one-by-one to isolate
        for rec in batch:
            r1 = post_single(rec)
            if r1.status_code in (200, 201, 204): inserted += 1
            else: failed.append({"rec": rec, "code": r1.status_code, "body": r1.text})
    else:
        inserted += len(batch)
```

### Step 8: Bulk SQL UPDATE for existing records (append tags + merge source)

**Do NOT use per-record PATCH via REST** (0.2 rec/s, takes hours). Use a SINGLE SQL UPDATE via Management API:

```python
# Build a WITH clause of all (identifier, new_tags, new_source) triplets
# Then UPDATE joined on identifier
query = f"""
WITH incoming(key_val, new_tags, new_source) AS (
  VALUES
    {",\\n".join(
      f"('{d.replace(chr(39), chr(39)+chr(39))}', ARRAY[{tags_sql}], '{src}')"
      for d, tags_sql, src in rows_to_update
    )}
)
UPDATE companies c
SET tags = i.new_tags,  -- OVERWRITE to canonical [client, niche, date]; do NOT union with old tags
source = CASE
  WHEN c.source IS NULL THEN i.new_source
  WHEN c.source LIKE '%' || i.new_source || '%' THEN c.source
  ELSE c.source || ',' || i.new_source
END,
client = COALESCE(c.client, '{CLIENT}'),
niche = COALESCE(c.niche, '{NICHE}'),
last_updated = NOW()
FROM incoming i
WHERE c.domain = i.key_val
"""
```

**Batch the VALUES clause in groups of 500** to keep query size manageable. ~5-10 sec per 500-record UPDATE. ~2 min for 5K records.

If some records are key-by-linkedin_url instead of domain, run a second UPDATE with `c.linkedin_url = i.key_val`.

### Step 9: Report

```
=== PUSH-TO-SUPABASE SUMMARY ===
Target table:              {companies|people}
Input records:             {n}
After dedupe:              {n}
Scrubbed/excluded:         {n}

Pre-flight (existing in DB):
  Matched by domain:       {n}
  Matched by linkedin_url: {n}

Partition:
  To INSERT (new):         {n}  → batch POST
  To UPDATE (existing):    {n}  → bulk SQL UPDATE

Execution:
  Inserted:                {n}
  Updated (tags appended): {n}
  Failed (isolated):       {n}

Per-record failure detail (if any):
  {record domain/URL} — code={code} — {body snippet}

Tags applied: [<client>, <niche>, <date>]   ← exactly 3 values, no prefixes
```

## Critical Rules (UPDATED 2026-04-24 based on real production push failures)

1. **DEDUPE KEY MUST MATCH DB UNIQUE CONSTRAINT.** For companies: domain (partial unique index). Not linkedin_url. Check schema FIRST.

2. **Pre-flight query existing records in bulk** (single SQL, batched 2000). Never query per-record.

3. **DO NOT use `on_conflict=` with partial unique constraints.** Returns 42P10. Pre-filter in-memory instead.

4. **On batch POST failure, retry that batch ONE-BY-ONE** to isolate the truly-conflicting record. Never count the whole batch as conflicted — most records are valid collateral damage.

5. **For existing-record tag/source append, use bulk SQL UPDATE via Management API** — NOT per-record REST PATCH. 100x faster.

6. **Null-domain records have no unique constraint** (partial `WHERE domain IS NOT NULL`). They all insert freely; dedupe them by linkedin_url.

7. **Source goes in `source` column ONLY, not in tags.** Canonical values only. Multi-source records: comma-separated in `source` field. Tags stay strictly `[client, niche, date]` — 3 values, no more.

8. **Log real failures with full response body** for debugging — not just counts.

9. **Always write a backup JSONL before push** (`{niche}-supabase-push-ready.jsonl`). Push can be retried from this file if anything goes wrong.

10. **Report per-provider source tag counts** after push so user can verify multi-source counts match expected overlap.

## Field Mappings Per Provider

### AI-Ark company (REST API)
```python
{
  "company_name": r["summary"]["name"],
  "legal_name": r["summary"].get("legal_name"),
  "domain": r["link"].get("domain_ltd") or r["link"].get("domain"),
  "website_url": r["link"].get("website"),
  "linkedin_url": r["link"].get("linkedin"),
  "industry": r["summary"].get("industry"),
  "city": r["location"]["headquarter"].get("city"),
  "state": r["location"]["headquarter"].get("state"),
  "country": r["location"]["headquarter"].get("country"),
  "employee_count": r["summary"]["staff"].get("total"),
  "phone": r["contact"]["phone"].get("sanitized"),
  "description": (r["summary"].get("description") or "")[:500],
  "founded_year": r["summary"].get("founded_year"),
  "revenue": f"{r['financial']['revenue']['annual'].get('start')}-{...}",
  "technologies": [t["name"] for t in r.get("technologies", [])],
  "source": "aiark",
  "custom_data": {"aiark_id": r["id"], "industries": r.get("industries"), "naics": r.get("naics"), "approaches": r.get("_approaches")},
}
```

### Blitz company (API)
```python
{
  "company_name": r.get("name"),
  "domain": r.get("domain"),
  "website_url": r.get("website"),
  "linkedin_url": r.get("linkedin_url"),
  "industry": r.get("industry"),
  "city": (r.get("hq") or {}).get("city"),
  "state": (r.get("hq") or {}).get("state"),
  "country": (r.get("hq") or {}).get("country_code"),
  "employee_count": r.get("employees_on_linkedin"),
  "founded_year": r.get("founded_year"),
  "description": (r.get("about") or "")[:500],
  "source": "blitz",
  "custom_data": {"linkedin_id": r.get("linkedin_id"), "approaches": r.get("_approaches"), "followers": r.get("followers")},
}
```

### Generic CSV import (Apollo scraper, Google Maps, Store Leads, Clutch, etc.)
This skill IS the universal CSV-import path. Process:
1. Read CSV headers + 5 sample rows
2. Propose column mapping → confirm with user
3. Ask for canonical source tag value (if new provider)
4. Ask client / niche / campaign-id / date
5. Run Steps 2-9 above

## When to use related skills

- Called by: `dual-source-companies`, `blitz-people`, `aiark-people`, generic CSV ingest flow
- Calls: `check-domain-health` edge function after bulk company push (tier classification)

## Known Gotchas (from 2026-04-24 Kynship push incident)

- **Partial unique constraints break `on_conflict`** (42P10). Pre-filter + bulk UPDATE for existing.
- **Batch INSERT is atomic**: one conflicting record fails the entire batch. Always retry one-by-one on batch failure.
- **REST PATCH per-record is 0.2 rec/s**. Bulk SQL UPDATE via Management API is 100x faster.
- **tags array doesn't merge via REST upsert** — requires SQL `array_agg(DISTINCT unnest(...))` pattern.
- **LinkedIn URL is NOT the dedupe key for companies** (no unique constraint). Domain is. Franchise expansion (multiple LinkedIn URLs, same domain) collides at DB level even when my dedupe thought it was unique.
- **When 6,800+ records went "missing" in Kynship push**: the root cause was my code counted 7,172 batch-rejected records as "conflicts" without retrying. Actual insert success rate of the remaining 7,172 would have been ~98% if retried one-by-one.
