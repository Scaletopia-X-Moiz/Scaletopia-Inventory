# End-to-end testing of EmailBison push (agent handoff runbook)

**Status:** Batch 1 (12 scenarios) pushed and verified 2026-08-16. **1 real bug
found** ([#144](https://github.com/Scaletopia-X-Moiz/Scaletopia-Inventory/issues/144) —
patch pushes wipe existing custom variables instead of leaving them alone).
Batch 2 redo (2026-08-16, later same day): **F2 PASS** — dedicated campaign
`QA-E2E-Camp-2` (id 1076) created, no-op reproduced cleanly (100/100 failed
attach, `campaign_tag` stayed pinned to F1's 1075), and Title was correctly
mapped to `job_title` this time (the field-sync step even retroactively fixed
F1's null-title defect on these same 100 leads). **F3 FAIL** — its dedicated
campaign `QA-E2E-Camp-3` (id 1077) has 0 real leads; all 5 companies failed
attach ("already in other sequences") because they'd already been attached to
the old ad-hoc campaign 1073 during pre-redo trial-and-error, so `campaign_tag`
is still pinned to 1073, not 1077; the field-sync step also corrupted `title`
to a stray literal typed during troubleshooting. **F4 PARTIAL** — landed in a
campaign (id 1078) that got misnamed `QA-E2E-Camp-3` again instead of
`QA-E2E-Camp-4` (no campaign with that name exists); 4/5 companies attached
correctly with clean standard fields, 1/5 failed (already pushed to 1073
earlier) and stayed pinned there; `qa_industry` custom var is absent on all 5
as the human reported (accepted deviation, not a defect). All landed on client
**Internal** again, not Testing — same client-mixup pattern as F1/Batch 1.
See §12 for full per-scenario results, §13 for findings. **Batch 2 (F1-F4) is
NOT fully done — F3 needs a genuine re-push to a clean slice/campaign, and F4
would benefit from a 5-lead re-push with the custom var + correct campaign
name, though the latter is optional per human's decision.**
Written 2026-08-16.

This file is a **complete, self-contained runbook**. Another agent should be able
to pick this up cold, re-derive nothing, and drive the rest of the test to
completion.

**Deviation from plan:** Batch 1 was actually pushed to client **Internal**
(`a8dfe6bc-dd09-4146-b628-fc0eacce34f3`), not **Testing** as this doc specifies
below. Internal already held leads from an older, unrelated QA round, so some
`Created`/`Updated` counts reflect that overlap rather than a clean run. The
oracle (`.scratch/eb-verify.mjs`) was extended with a `--client internal|testing`
flag to verify against whichever client was actually used — see §5.
**Recurred again in the Batch 2 redo (F2/F3/F4, same day):** despite the redo
checklist explicitly calling out "Testing, not Internal", all three redo
pushes again landed under client Internal (confirmed via `platform_pushes.client_id`
and `push_jobs.client_id`) — a repeated pattern across every round of this
test so far, worth a UI/muscle-memory check if a future round is run.

---

## 0. The single most important rule

**The AGENT never pushes to EmailBison. The HUMAN pushes through the UI; the
agent only verifies afterward.**

- Agent-side writes that are allowed: **read-only** Supabase `SELECT`s and
  **read-only** EmailBison `GET`s. (SQL `INSERT`s to seed test rows are allowed
  *only if the human explicitly asks* — they did NOT this round; "normal data
  only, no weird seeding".)
- Everything that creates/updates an EmailBison lead is the human clicking
  "Push {N}" in the app. Do not call the push orchestrator, do not POST to
  `/api/emailbison/push`, do not run `upsertLeadsBulk`.

## 1. Division of labor

1. Agent hands the human a scenario: exact filter URL + exact dialog settings +
   the expected **Push {N}**.
2. Human opens the URL on **https://inventory.scaletopia.io**, opens the push
   dialog, picks client **Testing**, sets the options, and reports the **Push
   {N}** number shown on the confirm button (this is the first filter check —
   it must equal the agent's computed count).
3. Human pushes. It enqueues a background job; progress/results show in
   **/push-activity** (not instant).
4. Once /push-activity shows the job done, agent runs the verification oracle
   for that scenario and reports item-by-item results.

## 2. Environment & access (verified 2026-08-16)

### Supabase (read-only for this task)
- Creds live in `D:/Scaletopia/Scaletopia-Inventory/.env.local` as
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. All scratch scripts load them via
  `dotenv`.
- `DATABASE_URL` for direct `psql` is **stale** (password rotated). Use the
  `@supabase/supabase-js` admin client, as every `.scratch/*.mjs` does. `node`
  and `tsx` both work here.

### EmailBison
- **One shared instance:** every client's `emailbison_workspace_id` is
  `https://send.scaletopia.io`. A "workspace" (lead pool) is scoped by the API
  **token** (`emailbison_api_key`), NOT by the URL. 15 clients have creds.
- **Test client = "Testing"**, id `0c556239-1608-41fc-9fda-89196c55a56f`
  (workspace_id stored with a trailing slash — strip it before concatenating
  paths). All pushes in this test go to **Testing**.
- (There is also "Internal", id `a8dfe6bc-dd09-4146-b628-fc0eacce34f3`, used in a
  prior QA round. Don't use it unless asked.)
- Read-back endpoints confirmed working:
  - `GET /api/leads/{id}` → the lead object directly (fields below).
  - `GET /api/leads?search=<email>` → paginated matches (15/page).
  - `GET /api/leads?page=N`, `GET /api/campaigns?page=N`,
    `GET /api/sender-emails?page=N`, `GET /api/custom-variables?page=N`.
  - A lead object's keys: `id, uuid, first_name, last_name, email, title,
    company, notes, status, custom_variables, tags, lead_campaign_data,
    overall_stats, created_at, updated_at`.
  - `custom_variables` is an array; each item is read as
    `{name, value}` (the oracle also tolerates `{variable:{name}, value}` /
    `{pivot:{value}}` shapes defensively).

### QA seed data (present, verified)
- Tag: `source_tokens` contains **`claude-qa-2026-08`**; emails/domains end
  `@claude-qa.example`.
- **10,400 people + 525 companies.**
- Distinct company niches: `b2b-saas, agency, ecommerce, fitness, dtc-beauty,
  qa-uncleaned, qa-orphan-nopeople`.
- Distinct people `niche_tokens`: `agency, fitness, dtc-beauty, b2b-saas,
  ecommerce, qa-uncleaned, qa-noemail`.
- Company `email` is never null (0 companies without email). People `qa-noemail`
  niche = 100 people, all with NULL email.

## 3. Filter → DB semantics (this is how "Push {N}" is computed)

The list "total" == the push candidate count. Filters are parsed in
`lib/data/companies-search-params.ts` / `lib/data/people-search-params.ts`
(shared `lib/data/include-exclude.ts`). No implicit quality-tier filter.

| URL param | Companies column | People column | Value format |
|---|---|---|---|
| `source` | `source_tokens` (array overlap) | `source_tokens` (overlap) | exact token, e.g. `claude-qa-2026-08` |
| `niche` | `niche` (scalar `.in`) | `niche_tokens` (overlap) | exact, case-sensitive |
| `country` | `country_id` (`.in`) | `country_id` (`.in`) | **ISO alpha-2**, e.g. `GB`,`CA`,`DE`,`US` — NOT "United Kingdom" |
| `industry` | `industry_id` (`.in`) | `industry_id` (`.in`) | canonical lowercase, e.g. `software development` |
| exclude | `<param>_exclude` | same | same |

- Multi-value = **repeated params** (`?niche=a&niche=b` = OR), not comma-joined.
- `country_id` is derived at ingest by `normalizeCountry()` (`lib/data/country.ts`):
  "United Kingdom"→`GB`, "Canada"→`CA`, "Germany"→`DE`, "United States"→`US`, etc.
- `industry_id` is derived by `normalizeIndustry()` (`lib/data/industry.ts`):
  lowercased, `;`→`,`, whitespace-collapsed.

## 4. Value resolution — how to compute "expected" for each lead

Source of truth: `lib/emailbison/lead-payload.ts` (`buildEmailBisonLeadPayload`,
`resolveCustomVariables`) + the per-entity record builders.

### Standard lead fields on the wire (`lib/emailbison/client.ts` `toWireLead`)
Only these top-level keys are sent: `email, first_name, last_name, company,
title, existing_lead_behavior`, plus `custom_variables` **only when non-empty**
(sending `custom_variables: []` on a patch WIPES existing vars, so an empty set
omits the key — see the comment in `toWireLead`). **`phone`/`website` are NOT
native fields** — they only reach EmailBison as custom variables.

### People (People-table push) default mapping
- `company` = linked company `brand_name` || person `company_name`
  (brand preferred when any record in the set has a brand; per-record raw
  fallback otherwise).
- `first_name`=person.first_name, `last_name`=person.last_name,
  `title`=person.job_title, `email`=person.email.
- Custom var column keys (dialog label → resolved value):
  City→person.city, State→person.state, Country→person.country,
  Domain→linked company.domain (`companyDomain`),
  Employees→linked company.employee_count (`companyEmployeeCount`),
  Industry→linked company.industry (`companyIndustry`), etc.

### Companies (company-native push — ADR 0005)
`lib/data/companies.ts` `toEmailBisonPushRecordForCompany` + company default
mapping (`resolveDefaultFieldMapping({platform:"emailbison", entity:"companies"})`):
- `company` = company `brand_name` || `company_name`.
- `first_name`/`last_name`/`title` default to **skip** (empty) — a company has no
  person name.
- `email` = company `email`. **A company with no email is skipped** (not pushed).
- Custom var column keys: Industry→company.industry, Domain→company.domain,
  Employees→company.employee_count, "Company name (raw)"→company_name,
  "Cleaned brand name"→brand_name, Founded year→founded_year, etc.
  (Full list in `components/companies/push-to-emailbison-button.tsx`
  `BINDABLE_RECORD_COLUMNS`; people list in the people button.)

### Custom-variable stringification (`resolveCustomVariables` + `stringifyCustomValue`)
- string→as-is; number/boolean→`String(v)` (so employee_count 75 → `"75"`);
  object/array→`JSON.stringify`.
- **null/undefined → the variable is DROPPED** for that record (not sent as `""`).
- Literal ("Static value") rows send the typed text verbatim to every lead.

### patch vs put
- **Partial update (patch, default):** only sends mapped fields; leaves others.
- **Full replace (put):** blanks any standard field set to `— ignore —` / skip
  (they go out as `null`).

## 5. The verification oracle: `.scratch/eb-verify.mjs`

Three-way reconciliation per scenario:
- **E** = expected rows, reproduced from the app's own filter semantics via
  Supabase (see §3).
- **A** = `platform_pushes` rows the app recorded (client=Testing,
  platform=emailbison) → maps entity id → EmailBison `platform_contact_id`
  (lead id) + `campaign_tag`.
- **EB** = the actual lead read back via `GET /api/leads/{leadId}`.

It reports: filter count (E) vs the human's Push {N}; **missing** (pushable in E
but no platform_pushes row); per-item **standard-field** mismatches; **custom-var**
mismatches (wrong value or missing); **absent-var** violations (a var that should
have been dropped but was sent); **email** mismatches; lead fetch failures. For
no-email slices it asserts nothing landed.

### Run it
```
node .scratch/eb-verify.mjs <SCENARIO> --since <ISO8601> [--client internal|testing|<raw-id>] [--campaign <id>]
```
`--client` defaults to `testing`. Pass `--client internal` to verify against the
Internal client (used for the actual 2026-08-16 Batch 1 run — see deviation note
in §0). A raw client UUID also works.
- `<SCENARIO>` ∈ `C1 C2 C3 A4 A5 G1 D1 D2 P1 P2 B3 B4 F1 F2 F3 F4` (A5 re-uses
  C3's config; D2 re-uses DE slice with put-blanked expected).
- `--campaign <id>` is required for F1–F4 (campaign scenarios, added
  2026-08-16 — see §6 Batch 2). It's the EmailBison campaign id that
  `platform_pushes.campaign_tag` must equal for every pushable row. For F2
  pass **F1's** campaign id (F2 is a deliberate no-op re-attach — attach
  should fail for everyone, so campaign_tag must stay pinned to F1's
  campaign, not move to F2's). Get the numeric id with
  `.scratch/eb-testing-probe.mjs` or a raw `GET /api/campaigns` — the human
  only ever sees the campaign by name in the UI, not its id.
- `--since` = an ISO timestamp just **before** the human pushed that scenario, so
  only this run's `platform_pushes` rows count. Get one with:
  `date -u +"%Y-%m-%dT%H:%M:%SZ"`. Record it right before the human starts a
  batch; any push after it is captured. (Omitting `--since` counts ALL historical
  pushes for those ids — fine for a dry count check, misleading for attribution.)
- **Dry validation** (no push needed): `--since 2099-01-01T00:00:00Z` forces A=0
  and just prints the filter count E — used to confirm each predicate reproduces
  the right "Push {N}".

### PASS/FAIL
Clean run = no missing, no field/var/email/absent mismatches, no fetch failures
(prints `PASS ✅`). Any mismatch → `FAIL ❌` with up to 8 examples each.

### Adding a scenario
Append to the `scenarios` object: `{ entity, label, filter:(q)=>q…,
computeExpected:(row, coById)=>({email, fields:{company,first,last,title},
cvars:{name:value}, absentCvars?:[names]}), needsCompany?, expectAllFail? }`.
`needsCompany:true` pre-loads linked companies into `coById` for people scenarios.

## 6. THE TEST MATRIX

All pushes go to client **Testing**. Prefix every filter with
`https://inventory.scaletopia.io`. Push in the order shown (A5 depends on C3; D2
depends on D1). Report the Push {N} for each.

### Batch 1 — plain "Add to EmailBison" (12 pushes)

| # | Filter | Expect N | Dialog settings (beyond client=Testing, Partial update, default mapping) | Verifies |
|---|---|---|---|---|
| C1 | `/companies?source=claude-qa-2026-08&niche=qa-uncleaned` | 15 | custom var `qa_industry` → Column **Industry** | company-native, raw-name fallback (brand null), custom var |
| C2 | `/companies?source=claude-qa-2026-08&niche=qa-orphan-nopeople` | 10 | — | orphan companies (0 linked people) push as their own leads (ADR 0005) |
| C3 | `/companies?source=claude-qa-2026-08&country=GB` | 50 | custom var `qa_industry` → Column **Industry** | country filter (GB), cleaned-brand-preferred, custom var |
| A5 | *(re-push C3, same link + settings)* | 50 | identical to C3 | created/updated split → expect **Created 0 / Updated 50**, no duplicate leads |
| A4 | `/companies?source=claude-qa-2026-08&niche=b2b-saas` | 100 | `qa_note` → **Static value** `batchA4`; `qa_founded` → Column **Founded year** | literal/static custom var lands; all-null column (founded_year) is **dropped**, not blank |
| G1 | `/companies?source=claude-qa-2026-08&industry=software%20development` | 60 | custom var `qa_industry` → Column **Industry** | industry filter (`industry_id`), custom var |
| D1 | `/companies?source=claude-qa-2026-08&country=DE` | 50 | Standard fields: First name → **Static value** `QA-FN`; Last name → **Static value** `QA-LN` | static values on standard fields |
| D2 | *(re-push D1, same link)* | 50 | Existing lead behavior → **Full replace**; Standard fields: First name → **— ignore —**, Last name → **— ignore —** | **put blanks the ignored fields** (first/last go empty) |
| P1 | `/people?source=claude-qa-2026-08&niche=qa-uncleaned` | 300 | 4 custom vars (all Column): `qa_city`→City, `qa_state`→State, `qa_company_domain`→Domain, `qa_employees`→Employees | people custom-var fidelity (incl. numeric→string), raw-name fallback |
| P2 | `/people?source=claude-qa-2026-08&niche=qa-noemail` | 100 | — | no-email → all fail with reason; 0 leads land |
| B3 | `/people?source=claude-qa-2026-08&country=CA` | 1000 | — | people country filter integrity + volume (worker batching) |
| B4 | `/people?source=claude-qa-2026-08&niche=qa-noemail&niche=qa-uncleaned` | 400 | — | mixed batch: ~300 succeed + 100 fail, reasons persist |

Expected per-scenario landed values (what the oracle asserts):
- **C1/A4/b2b**: `company` = brand_name || company_name. C1 (qa-uncleaned) brands are
  null → company = "Raw Uncleaned Co NNNN"; b2b/GB/DE have brands → "QA Brand NNNN".
  first/last/title empty. email = `hello@qa-…claude-qa.example`.
- **C1**: qa_industry = "marketing and advertising" (all 15).
- **A4**: qa_note = "batchA4" (all); qa_founded absent (all). company = "QA Brand NNNN".
- **P1**: qa_city="Denver", qa_state="CO", qa_company_domain=linked
  `qa-uncleaned-co-NNNN.claude-qa.example`, qa_employees="75"; company = "Raw
  Uncleaned Co NNNN"; title="Founder".
- **D1**: first="QA-FN", last="QA-LN" on all 50. **D2**: first="", last="" on all 50.
- **P2**: 0 landed; /push-activity shows 100 "no email on record".
- **B4**: 300 with-email land; 100 no-email fail.

Non-oracle checks (read from **/push-activity** UI, ask the human):
- A5: "Created 0 / Updated 50".
- P2/B4: the failed count + the per-lead "no email on record" reason text.

### Batch 2 — "Add to EmailBison Campaign" (4 pushes)

**Designed and ready to run 2026-08-16** (not yet pushed — see §12). The
campaign flow adds a Campaign step (pick or **+ Create a campaign** → name,
pick a sender email, set a schedule; a required sequence step with
subject+body) and a launch step. Testing workspace already has a connected
sender (`ian.johnson@prospectchambermedia.com`, id 10473).

**Slices** — deliberately fresh niche/country/industry combinations untouched
by any Batch 1 filter, so campaign_tag/custom-var attribution here can't be
confused with a Batch 1 push. (Batch 1 touched: companies niche
`qa-uncleaned`/`qa-orphan-nopeople`/`b2b-saas`, country `GB`/`DE` (**all**
industries in those two countries), industry `software development`
(**all** countries); people niche `qa-uncleaned`/`qa-noemail`, country `CA`.
Confirmed via `.scratch/eb-batch2-slice-final.mjs` that these four slices have
0 prior `platform_pushes` rows.)

| # | Filter | Expect N | Entity | Verifies |
|---|---|---|---|---|
| F1 | `/people?source=claude-qa-2026-08&niche=fitness&country=IT&industry=retail` | 100 | People | create campaign `QA-E2E-Camp-1`, attach, `campaign_tag` set |
| F2 | *(re-push F1's exact same filter)* | 100 | People | create campaign `QA-E2E-Camp-2`, attach — must **no-op** (issue #106): everyone already active in Camp-1 → all fail with a reason, `campaign_tag` stays pinned to Camp-1 |
| F3 | `/companies?source=claude-qa-2026-08&niche=dtc-beauty&country=FR&industry=retail` | 5 | Companies | company-native campaign attach, create `QA-E2E-Camp-3` |
| F4 | `/companies?source=claude-qa-2026-08&niche=ecommerce&country=CA&industry=retail` | 5 | Companies | campaign attach **with** a custom var (`qa_industry`→Column **Industry**) — confirms the field-sync re-upsert path (`runEmailBisonAddToCampaign`, `lib/emailbison/push-to-emailbison.ts:770-778`): attach never sends vars itself, so a var-carrying campaign push re-upserts every candidate through the workspace path first, create `QA-E2E-Camp-4` |

Push in that exact order (F2 depends on F1 already having attached the same
people). Prefix every filter with `https://inventory.scaletopia.io`.

**What actually happened 2026-08-16 (deviation from plan):** The human pushed
to client **Internal** (`a8dfe6bc-dd09-4146-b628-fc0eacce34f3`), not Testing —
same deviation as Batch 1 (§0). This is also why the naive `platform_pushes`
check against the Testing client_id initially looked empty; the real rows are
under Internal. All Batch 2 activity is reconstructed from the `push_jobs`
table (one row per background job — has `client_id`, `campaign_id`, `filters`,
`options`, `status`, `succeeded`/`failed`, `failures[]`, timestamps; not
mentioned elsewhere in this doc but the most reliable read for "what actually
ran").

Only **F1** was pushed per the matrix: new campaign **1075**
(`moiz_sunday_qa_test_2` — human used their own name, not `QA-E2E-Camp-1`; this
is fine, just note it so a future reader isn't confused), 100/100 people
succeeded, `campaign_tag=1075` on all. Confirmed 1:1 against the F1 candidate
set (see §13 finding).

**F2/F3/F4 were not run as designed.** No `QA-E2E-Camp-2/3/4` campaigns exist —
only 3 campaigns were created today: 1073 (`moiz_qa_company`, draft, 199 total
leads — an ad-hoc campaign the human reused across several unrelated
trial-and-error attach attempts before settling on the F1 flow), 1074
(`moiz_qa_testing_sunday_1`, draft, **0 leads** — an abandoned early attempt to
campaign-attach C1/C2's companies, which failed with EmailBison's "already in
other sequences" 422 both times; the human then fell back to a plain
non-campaign "Add to EmailBison" push for C1/C2, which is what actually landed
and is reflected as C1/C2 PASS in §12 — 1074 doesn't affect any scenario), and
1075 (F1, above). A `push_jobs` row for the F2 candidate set (same
fitness/IT/retail people) does exist, attempted against campaign **1073**
(not a new campaign) — it failed 100/100 with the expected "already in other
sequences" reason, so the *no-op behavior* F2 is meant to verify did happen,
just not against a dedicated F2 campaign. F3's slice (dtc-beauty/FR/retail
companies) has `platform_pushes` rows tagged `campaign_tag=1073` (partial: 4/5
succeeded attach, 1 failed same reason) plus a later plain workspace push with
an unplanned `city` custom var (not `qa_industry` as F3... actually F3 has no
var in the plan) — again not run as the matrix specifies. F4's slice
(ecommerce/CA/retail companies) has essentially **no real push activity**: only
1 of the 5 candidate companies has a stray `platform_pushes` row, timestamped
during an unrelated earlier blanket test push, not a real F4 campaign attach.
**F2/F3/F4 should be re-run properly per the matrix above** before Batch 2 can
be marked done.

**Redo outcome (2026-08-16, later same day):** F2 was redone correctly and
PASSes cleanly. F3 and F4 were also attempted via the redo checklist below, but
because the pre-redo trial-and-error above had already attached F3's and (one
of) F4's companies to the old ad-hoc campaign 1073, EmailBison's "already in
other sequences" no-op kicked in for the redo attempts too — F3 landed 0 leads
on its new campaign (all 5 stayed pinned to 1073) and F4 landed 4/5 on its new
campaign (1/5 stayed pinned to 1073). See §12/§13 for full detail. **Batch 2 is
still not fully done: F3 needs a genuine re-push against companies with no
prior push history (or a brand-new campaign after confirming these 5 aren't
already active elsewhere), and F4's 5th company + missing `qa_industry` var
would need a follow-up push if the human wants a clean 5/5.**

**Redo checklist for F2/F3/F4 (2026-08-16):** F1 is done (§12, PASS with the
title caveat) — nothing to redo there. For the remaining three:
1. Client picker → **Testing** (`0c556239-1608-41fc-9fda-89196c55a56f`), not
   Internal — that's what went wrong last time.
2. Each gets its **own freshly-created campaign** (`QA-E2E-Camp-2`,
   `QA-E2E-Camp-3`, `QA-E2E-Camp-4`) via "+ Create a campaign" — don't reuse
   1073 or any other existing campaign.
3. **F2 only** (People): in the options step, open the Standard Field Mapping
   table and manually set **Title → job_title** before continuing — this is
   the workaround for the dialog-carryover bug that hit F1 (§13); don't rely
   on the dialog's default.
4. F3/F4 (Companies) don't need a Title mapping — title defaults to skip by
   design for company-native pushes (§13 "confirmed non-bug").
5. Otherwise follow the exact UI steps below, in order: F2 → F3 → F4 (F2 no
   longer strictly depends on F1 being redone since F1 already landed, but
   keep the order for a clean read).
6. Report each Push {N} (100 / 5 / 5) before confirming, same as always.

**Exact UI steps per push** (client = Testing throughout):
1. Picker step → select client **Testing** → Continue.
2. Campaign step → click **+ Create a campaign**:
   - Name: the campaign name from the table above (`QA-E2E-Camp-1` etc — exact
     spelling matters, the agent looks the campaign up by name afterward to
     get its id for oracle `--campaign`).
   - Schedule: leave every default (Mon–Fri, 09:00–17:00, America/New_York) —
     not under test.
   - Sender emails: check `ian.johnson@prospectchambermedia.com` (the only
     connected sender).
   - Sequence steps: Step 1 needs a non-empty Subject and Body (required to
     enable the button) — anything works, e.g. Subject `QA E2E test`, Body
     `QA test email, please ignore.` Leave it at one step, no split-test
     variant.
   - Click **Create campaign** (it auto-selects as the chosen campaign).
3. **F4 only**: in the options step, click **+ Add variable** → name
   `qa_industry`, source **Column** → **Industry**. F1/F2/F3: leave Existing
   lead behavior at the default (Partial update) and add no custom variables.
   Continue →.
4. Confirm step → click **Push {N}** → report the **Push {N}** shown (must
   equal the table's Expect N) before continuing — this is the filter check.
5. A **"Launch campaign?"** prompt appears (every campaign here is a
   freshly-created draft) → click **"Just add leads"**, NOT "Add leads &
   launch". **Do not launch** — these are QA leads with placeholder copy, and
   launching would start sending real emails through the connected sender.
6. It enqueues a background job; progress/results show in **/push-activity**
   (not instant, same as Batch 1).

Once each job shows done, the agent looks up the new campaign's id (read-only
`GET /api/campaigns` or the `.scratch/eb-testing-probe.mjs` campaigns list,
matched by the exact name) and runs:
```
node .scratch/eb-verify.mjs F1 --since <ISO8601-before-this-push> --campaign <F1's numeric id>
```
For F2, pass **F1's** campaign id (not F2's — see the table). For F2 also ask
the human to confirm in **/push-activity** that all 100 show a failed status
with an "already in a campaign"/"another sequence"-style reason (the oracle's
campaign_tag check alone can't distinguish "no-op'd correctly" from "never
attempted" — see the printed F2 note in the oracle's own output).

## 7. Scratch tooling inventory (all read-only)

- `.scratch/eb-verify.mjs` — **the oracle** (§5). The main deliverable.
- `.scratch/eb-recon-state.mjs` — lists EB clients, QA seed counts, lead read-back shape.
- `.scratch/eb-testing-probe.mjs` — Testing workspace state (leads/campaigns/senders/vars) + QA schema samples.
- `.scratch/eb-counts.mjs` — per-filter QA counts (source of the "Expect N" numbers).
- `.scratch/eb-people-completeness.mjs` — people data completeness per niche.
- `.scratch/eb-edgedata.mjs` — edge-scenario data checks (arrays, DE, industry, CA, mixed).
- `.scratch/eb-leadshape-probe.mjs` — `/api/leads/{id}` + custom_variables shape.
- `.scratch/eb-batch2-slice-final.mjs` — computes/confirms the F1–F4 slice
  counts (100/5/5) and their zero prior-push overlap with Batch 1.
- `.scratch/eb-batch2-check-pushed.mjs` — inspects the one stray
  pre-existing `pushed_to_emailbison` flag found on F3/F4's candidates (dated
  before Batch 1, no `platform_pushes` row — harmless, doesn't affect the
  oracle's `--since` attribution).
- Prior-round scripts worth knowing: `.scratch/eb-search-leads.mjs`,
  `.scratch/eb-cleanup-orphan-test-data.mjs`, `.scratch/eb-e2e-recon2.mjs`.

## 8. Known gaps / NOT covered live (be honest about these)

- **Array→JSON custom var**: the seed has no populated array columns
  (keywords/technologies/tags empty), so JSON-encoding of a multi-value column is
  NOT exercised live. Covered only by the mocked unit test. Would need seeding
  (human declined) to test live.
- **Enrichment / virtual-column custom vars**: QA people `custom_data` is `{}`, so
  binding a var to an enrichment column can't be value-checked live.
- **Worker resumability** (deadline/offset ticking on huge jobs) is only observed
  indirectly via B3 (1000) "did everything land". Not a targeted test.
- **Two-client custom-var cache-key isolation**, **sender/warmup >15-item
  pagination**, **stranded-job reaper / cron whitelist** — need a different setup
  (multiple workspaces / >15 mailboxes / infra) and are out of scope here.
- Campaign A/B variant, parallel-send toggle, schedule/sender attach — only lightly
  touched by F1–F4 as planned (no A/B variant added, schedule left default, no
  actual send/launch since F1-F4 explicitly avoid launching).

## 9. Stale-doc finding (report, do NOT rewrite — human's instruction)

- `docs/emailbison-push-test-plan.md` scenarios **S8/S9** and the
  `describe("runCompaniesAddToEmailBison")` block in
  `lib/emailbison/push-to-emailbison.test.ts` still describe the OLD
  "company push resolves to linked people" behavior. **ADR 0005**
  (`docs/adr/0005-company-native-emailbison-push.md`) reversed this: a Companies
  push is now **company-native** (each company is its own lead). The live code is
  correct/company-native; the doc + that test block are stale. C1/C2/C3 above are
  the corrected company scenarios. The human asked NOT to rewrite the docs, so
  just flag this in findings.

## 10. Cleanup (after testing, when the human says so)

- EmailBison test leads live under Testing's token with `@claude-qa.example`
  emails — searchable via `GET /api/leads?search=claude-qa`. A prior cleanup
  helper exists: `.scratch/eb-cleanup-orphan-test-data.mjs` (review before
  running; adapt to Testing). Deleting leads is a WRITE — only with human ok.
- Supabase `pushed_to_emailbison` flags + `platform_pushes` rows get written by
  the pushes; reset only if the human wants a clean slate.
- The whole QA seed can be removed with `node .scratch/seed-qa-people.mjs
  --cleanup` (per `docs/emailbison-push-test-plan.md`) — do NOT run unless asked;
  it destroys the shared seed other tests rely on.

## 11. Key source files

- Orchestrator: `lib/emailbison/push-to-emailbison.ts` (runPeople/Companies AddTo
  EmailBison / AddToCampaign).
- HTTP client: `lib/emailbison/client.ts` (upsertLeadsBulk, attachLeadsToCampaign,
  listCustomVariables, campaign/sender/schedule/sequence calls, `toWireLead`).
- Payload/mapping: `lib/emailbison/lead-payload.ts`,
  `lib/push/resolve-default-field-mapping.ts`, `lib/push/standard-field-source.ts`.
- Data loaders: `lib/data/people.ts` `getPeopleForEmailBison`,
  `lib/data/companies.ts` `getCompaniesForEmailBison` +
  `toEmailBisonPushRecordForCompany`.
- Dialogs: `components/{people,companies}/push-to-emailbison-button.tsx`,
  `components/emailbison/standard-field-mapping-table.tsx`.
- Filters: `lib/data/{companies,people}-search-params.ts`,
  `lib/data/include-exclude.ts`, `lib/data/{country,industry}.ts`.
- Existing (mocked) tests: `lib/emailbison/push-to-emailbison.test.ts`,
  `lib/data/people-emailbison.test.ts`.
- ADRs: `docs/adr/0003-emailbison-two-push-actions.md`,
  `docs/adr/0005-company-native-emailbison-push.md`.

## 12. Progress log (update as you go)

All pushed 2026-08-16, ~14:55-15:05 UTC, to client **Internal** (see deviation
note in §0). Verified with the corrected oracle (`.scratch/eb-verify.mjs
<S> --client internal --since 2026-08-16T00:00:00Z`) plus manual `push_jobs` /
raw-lead cross-checks. Full explanation of every non-clean result is in §13.

| Scenario | Pushed? | Push N reported | Verified | Result |
|---|---|---|---|---|
| C1 | yes | 15 | yes | **PASS** — 0 mismatches |
| C2 | yes | 10 | yes | **PASS** — 0 mismatches |
| C3 | yes | 50 | yes | **PASS at push time** — own fields/email correct; `qa_industry` later overwritten by A4/G1 (§13 finding 1, issue #144) |
| A5 | yes | 50 | yes | **DEVIATION** — fields correct, but re-push wasn't configured with `qa_industry` (not identical to C3 as planned); no new leads created (consistent with "Updated 50") |
| A4 | yes | 100 | yes | **FAIL** — `qa_note` typed as `"batch4a"` not `"batchA4"` (data-entry, not a bug) on 90/100; missing entirely on 10/100 (wiped by G1, issue #144); `qa_founded` correctly absent on all 100 |
| G1 | yes | 60 | yes | **PASS at push time** — own fields/`qa_industry` correct; later overwritten on 5/60 leads by D1 (issue #144) |
| D1 | yes | 50 | yes | **DEVIATION** — static-value mechanism works correctly; literal text typed was `qa_fn`/`qa_ln`, not `QA-FN`/`QA-LN` per plan |
| D2 | yes | 50 | yes | **FAIL (API limitation, not a code bug)** — 0/50 succeeded; EmailBison 422s `put` + skipped `first_name` ("first_name field is required"). Confirmed expected/non-fixable — EmailBison requires non-empty first_name server-side. Live leads still show D1's values (no-op, not a partial blank). |
| P1 | yes | 300 | yes | **FAIL** — `title` mapped to "skip" instead of job_title (likely leftover dialog state, not a code bug) on all 300; all 4 custom vars wiped to `[]` by B4's later push (issue #144, and directly contradicts the code's "omit empty custom_variables key" safeguard) |
| P2 | yes | 100 | yes | **PASS** — 100/100 correctly failed with "no email on record" |
| B3 | yes | 1000 | yes | **FAIL** — `title` mapped to "skip" instead of job_title on all 1000 (same as P1); no custom-var issue (none configured) |
| B4 | yes | 400 | yes | **DEVIATION** — 300 succeeded / 100 failed exactly as planned; same `title:skip` carryover as P1/B3; this is the job that wiped P1's custom vars |
| F1 | yes | 100 | yes | **PASS (accepted with caveat)** — email set matches F1 candidates exactly (100/100, 0 missing, 0 extra), `campaign_tag=1075` correct on all, campaign-attach mechanism itself fully correct; `title` landed `null` instead of job_title on all 100 (same dialog-carryover pattern as P1/B3/B4, §13) but human accepted this — a manual Title mapping in the dialog is a known working workaround, not chasing the underlying carryover further right now |
| F2 (pre-redo) | attempted, not per plan | — | no | reused pre-existing campaign 1073 instead of a new `QA-E2E-Camp-2`; no-op behavior (100/100 failed "already in other sequences") did occur, but not run as the matrix specifies — not oracle-verified |
| F3 (pre-redo) | attempted, not per plan | — | no | reused campaign 1073 (partial 4/5 attach) + an unplanned plain workspace push with a `city` custom var; no `QA-E2E-Camp-3` created — not run as specified, not oracle-verified |
| F4 (pre-redo) | no | — | no | no real push activity found; 1/5 candidate companies has a stray `platform_pushes` row from an unrelated earlier test, not a genuine F4 push |
| F2 (redo) | yes | 100 | yes | **PASS** — dedicated campaign `QA-E2E-Camp-2` (id 1076) created; all 100 correctly failed attach ("already in other sequences" per `push_jobs`, client Internal again — not Testing), `campaign_tag` stayed pinned to F1's 1075 on all 100 (oracle: 0 missing/field/cvar/campaign_tag mismatches). Title was correctly manually mapped to `job_title` this time (`push_jobs.options.standardFieldMapping.title:"title"`) and the field-sync step landed the correct `job_title` value on all 100 leads (oracle: 0 standard-field mismatches) — this incidentally also fixed F1's null-title defect on these same 100 leads. |
| F3 (redo) | attempted | 5 | yes | **FAIL** — dedicated campaign `QA-E2E-Camp-3` (id 1077) was created but attach failed 5/5 ("already in other sequences"): these 5 companies had already been attached to old campaign 1073 during the pre-redo trial-and-error above, so `campaign_tag` is still pinned to 1073 for all 5, not 1077 (1077 has 0 real leads). The redo job's field-sync step also wrote `title="no title in these records"` (a literal typed during troubleshooting) onto all 5 companies instead of the correct empty/skip default — a data-entry mistake, not a code bug, but it does mean these 5 leads currently have a wrong title. F3 needs a genuine re-push. |
| F4 (redo) | yes | 5 | yes | **PARTIAL** — landed in campaign id 1078, which got misnamed `QA-E2E-Camp-3` again instead of `QA-E2E-Camp-4` (no campaign named `QA-E2E-Camp-4` exists in the workspace). 4/5 companies attached correctly (`campaign_tag=1078`, standard fields company/first/last/title all correct, 0 mismatches); 1/5 (`QA Brand 0223`) failed attach — it had already been pushed to old campaign 1073 during earlier trial-and-error, so it stayed pinned to 1073. **DEVIATION (accepted, as reported)** — `qa_industry` custom var is absent on all 5 (confirmed via `push_jobs.options.customVariables:[]`), matching the human's own report of forgetting it; not treated as a defect. |

## 13. Findings from the 2026-08-16 Batch 1 run

### Confirmed bug — filed as [#144](https://github.com/Scaletopia-X-Moiz/Scaletopia-Inventory/issues/144)
**Patch pushes wipe existing custom variables instead of leaving them alone.**
Any lead pushed more than once (overlapping filters across different
scenarios/campaigns/re-syncs), where the later push carries a different set of
custom variables — even an *empty* set — loses whatever custom variables an
earlier push had set. Clearest evidence: P1 pushed 4 custom vars onto 300
people and they landed correctly; B4's later push over the same 300 people
(`customVariables: []`) wiped all 4 to nothing, even though the code has an
explicit safeguard (`toWireLead` in `lib/emailbison/client.ts`) meant to omit
the `custom_variables` key entirely when there are zero variables configured,
specifically to prevent this. Also visible in the C3→A4→G1→D1 chain, where each
later push (different/no custom vars configured) erased the previous one's
variables on the companies they had in common. This is a live data-loss risk in
production, not just a test artifact — the QA seed's overlapping niches just
made it easy to reproduce.

### Confirmed non-bug (initially misdiagnosed, corrected)
The company-native default mapping (`firstName` ← raw company name, `lastName`
← literal `"company last name"`, `title` → skip) was initially flagged as a bug
during verification. It is not — it's the actual coded default
(`lib/push/resolve-default-field-mapping.ts:98-111`, ADR-0005 era), confirmed
against a screenshot of the live dialog. **This runbook's §4 "first/last/title
default to skip" claim above is stale/wrong** — the real default fills
first/last as described here; only `title` defaults to skip. Left uncorrected
above per the existing stale-doc precedent in §9 (human asked not to rewrite
docs); noting the correction here instead.

### Confirmed non-bug — D2 / EmailBison API constraint
`existing_lead_behavior: put` with `first_name` set to skip/ignore sends
`first_name: null` on the wire. EmailBison's API hard-rejects this with
`422: "first_name field is required"` — confirmed via the actual API error, not
app logic. This runbook's §6 assumption that "put blanks the ignored fields"
does not hold for `first_name` specifically. Not actionable as a bug; document
as a known constraint if this combination is ever needed for real client work.

### Likely dialog-state carryover, not investigated further
`title` mapped to "skip" instead of the coded People-push default (`title` →
job_title) across P1/B3/B4 — all three landed `title: null` instead of the
person's actual job title. Most likely leftover mapping state from an earlier
dialog session (the Companies push dialog was fixed not to persist mappings
across sessions per commit `c0e422c`; the People dialog was not, per that same
commit's scope). Confirm the dialog's current mapping before the next People
push; not filed as an issue since it's plausibly by-design persistence rather
than a defect.

**Update 2026-08-16, Batch 2 F1:** same symptom reproduced in the campaign
flow. `push_jobs` for F1 (job attaching campaign 1075) shows
`standardFieldMapping.title: "skip"`; the oracle
(`.scratch/eb-verify.mjs F1 --client internal --since 2026-08-16T17:50:40Z
--campaign 1075`) confirms `title: null` on all 100 landed leads vs. expected
`job_title` ("Owner" for all in this slice). This is now the fourth People-push
run in a row (P1, B3, B4, F1) with the same skip default — strengthens the
carryover-bug theory over a one-off mistake; worth checking the People dialog's
persisted-mapping code path if it recurs on a fifth run. Confirmed via
`.scratch/eb-f1-check.mjs` (F1 candidates), `.scratch/eb-f1-fetch-campaign.mjs`
(campaign 1075's 100 leads), `.scratch/eb-f1-compare.mjs` (1:1 email-set
match), and the oracle run above.

**Decision 2026-08-16:** human reviewed this and chose not to chase the
underlying carryover further right now — a manual Title→job_title mapping in
the dialog's options step is a confirmed, easy workaround, and everything else
about F1 (campaign attach, `campaign_tag`, email, standard fields) was clean.
F1 is marked **PASS with this caveat** in §12, not blocked on this bug. For any
future People-table campaign/workspace push (F2 included), explicitly check
the Title row in the Standard Field Mapping table before clicking Push.

**Update 2026-08-16, Batch 2 F2 redo:** the manual-mapping workaround was
applied and worked. `push_jobs` for F2's redo (campaign 1076) shows
`standardFieldMapping.title: "title"`, and the oracle
(`.scratch/eb-verify.mjs F2 --client internal --since 2026-08-16T18:08:00Z
--campaign 1075`) confirms 0 standard-field mismatches on all 100 leads —
title now correctly reads each person's `job_title`. Since F2 targets the same
100 leads F1 already created, this also retroactively fixed F1's null-title
defect on those leads (the field-sync/upsert step runs regardless of whether
the campaign attach itself succeeds or fails).

**Unrelated, separately observed during the F3 redo:** `title` also landed
wrong on F3's 5 companies, but not via the carryover pattern above — this was
a literal value (`"no title in these records"`) typed into the dialog's Title
row during troubleshooting (`push_jobs.options.standardFieldMapping.title:
"literal:no title in these records "`), not a leftover "skip" default. Noted
here for completeness; not the same mechanism as the P1/B3/B4/F1 carryover bug.
