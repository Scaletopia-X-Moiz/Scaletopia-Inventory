# TESTING FINAL — Push QA at Scale (EmailBison + GHL)

**Base site:** https://inventory.scaletopia.io
**Seeded:** 2026-08-18 · **10,500 fake people + 2,701 fake companies**, all tagged
`source = 'qa-push-plan-20260818'`.

This doc has two audiences:
- **PUSHER (a human — Moiz):** Parts 0–4. Click the links, choose the settings,
  push, and fill the **Results Log**.
- **VERIFIER (a subagent):** Part 5. Runs `.qa-tmp/verify-results.ts` and confirms,
  field-by-field, what actually landed. Everything the verifier needs is in Part 5.

> **Cleanup is Supabase-only.** The EmailBison "Testing" workspace and GHL
> "Internal" location are throwaway test campaigns — leads/contacts created there
> do **not** need cleanup. Only the seeded Supabase rows get deleted (Part 6).

## Targets — pick by DISPLAYED NAME in the client picker (name/slug are inverted!)

| Platform | Pick this client **name** | (slug) | Verifier client_id |
|---|---|---|---|
| **EmailBison** | **Testing** | `internal` | `a8dfe6bc-dd09-4146-b628-fc0eacce34f3` |
| **GHL** | **Internal** | `testing` | `0c556239-1608-41fc-9fda-89196c55a56f` |

Use the **same** client for all tests of a platform.

## "Rewrites / full rewrites" — what that actually is

There is **no feature literally named "rewrite."** It maps to:
- **EmailBison "Existing lead behavior": Partial update (patch)** = only sent
  fields are written; the rest are left alone. **Full replace (put)** = every
  native field / custom var you did **not** send is **blanked** (this is the
  closest thing to a "full rewrite"). → **EB-5**.
- **"Static value" source** on any field (both platforms) = a per-field verbatim
  override (a per-field "rewrite" of the value). → **EB-4 / G-5**.
- EmailBison must **not** wipe existing custom vars when you send none (omit-on-
  empty). → **EB-3**.

## How the links work (why the counts are exact)

No tag filter exists in the UI, so each slice is carved by full-text `?q=`:
- **/people** `q` matches `full_name` OR `email` (ILIKE `%q%`).
- **/companies** `q` matches `company_name` OR `domain`.
Every seeded person carries its slice token in `full_name`; every seeded company
carries it in `domain`. All counts below are verified live against the DB.

## Deterministic value formulas (so the verifier can compute expected values for any record)

Each seeded record has a 1-based index **n** encoded in its email (`u{n}@…` for
people, `hello{n}@…` for companies) and its `full_name` (`… {n} qa0818-<token>`).
Let `i = (n-1) % 8`.

- `FIRST = [Jane, Mark, Priya, Diego, Aisha, Tom, Lena, Omar]`
- `LAST  = [Doe, Rivera, Nair, Costa, Khan, Blake, Frost, Reed]`
- `CITY  = [Austin, Denver, Seattle, Miami, Boston, Portland, Chicago, Phoenix]` (state `[TX,CO,WA,FL,MA,OR,IL,AZ]`)
- person: first=`FIRST[i]`, last=`LAST[i]`, email=`u{n}@qa0818-<token>.test`,
  company_name=`<CompanyBase> {n}`, job_title=`<TitleBase> {n}`, city=`CITY[i]`,
  employee_count=`50 + ((n-1)%50)`, phone=`+1<prefix>{n:05}`.
- **GHL-MAIN** people have **city = null when `n % 3 == 0`** (drop-if-empty test).

| Slice token | CompanyBase | TitleBase | tags | phone_type |
|---|---|---|---|---|
| `qa0818-ebmain` | Widgetworks Incorporated | Head of QA | `[alpha,beta]` | mobile |
| `qa0818-ebbrand` | QA Brandtest Cosmetics LLC | Brand Manager | `[cosmetics]` | mobile |
| `qa0818-ebnoemail` | Emailless Co | Ops Lead | — | mobile (no email) |
| `qa0818-ebmixed` | Mixedbatch LLC | Analyst | — | mobile |
| `qa0818-ebcamp` | Campaignco | Campaign Target | — | mobile |
| `qa0818-ghlmix` | Ghlmix Co | Mixed Phone | — | mobile (n≤600) / null |
| `qa0818-ghlvoip` | Ghlvoip Co | Voip Only | — | voip |
| `qa0818-ghlmain` | Northgate Systems | GHL Main | `[red,green,blue]` | mobile |

- **BRAND slice:** all `ebbrand` people link to one company whose **raw name is
  `QA Brandtest Cosmetics LLC`** but **cleaned brand is `QA Brandtest`** → the
  push's Company field must resolve to **`QA Brandtest`**.
- **Company-native slices:** `ebcemail` → `Northwind Traders {n}`; `ebcmixed` →
  `Contoso Partners {n}`. Native lead shape: **Company = the company name,
  First = the company name, Last = literal `company last name`, Title empty.**

---

## MASTER LINK TABLE

| Slice | Link | Matched | EB pushable (email) | GHL eligible (mobile) |
|---|---|---|---|---|
| EB people MAIN | `/people?q=qa0818-ebmain` | 1500 | 1500 | — |
| EB people BRAND | `/people?q=qa0818-ebbrand` | 1000 | 1000 | — |
| EB people NOEMAIL | `/people?q=qa0818-ebnoemail` | 1000 | 0 | — |
| EB people MIXED | `/people?q=qa0818-ebmixed` | 1500 | 1000 | — |
| EB people CAMP | `/people?q=qa0818-ebcamp` | 1500 | 1500 | — |
| EB companies EMAIL | `/companies?q=qa0818-ebcemail` | 1200 | 1200 | — |
| EB companies MIXED | `/companies?q=qa0818-ebcmixed` | 1500 | 800 | — |
| GHL MIXED | `/people?q=qa0818-ghlmix` | 1500 | — | **600** |
| GHL VOIP | `/people?q=qa0818-ghlvoip` | 1000 | — | **0** |
| GHL MAIN | `/people?q=qa0818-ghlmain` | 1500 | — | **1500** |
| **SCALE — ALL people** | `/people?q=qa0818` | **10500** | **9000** | **8600** |
| SCALE — ALL companies | `/companies?q=qa0818` | 2701 | 2000 | — |

(prefix every link with `https://inventory.scaletopia.io`)

---

# PART 0 — THE 10K SCALE TEST (run these; they are the headline)

### S-EB — Push 10,500 people to EmailBison in one shot
- **Link:** `/people?q=qa0818` (10,500). Client **Testing**. Button **✉ Add to
  EmailBison**. Existing lead behavior **Partial update**. Standard defaults.
  Add 2 custom vars (Column): `qa_city` ← City, `qa_employees` ← Employees.
- **Push (10500).** (This exercises the multi-tick worker on a real 10k batch.)
- **Expect (Push Activity):** Total **10500**, **Created ~9000**, **Failed ~1500**
  (the 1500 with no email), 0 stuck. Reasons for failures = "no email on record".
- **Verify:** `npx tsx .qa-tmp/verify-results.ts qa0818 emailbison people 5` →
  expects **9000** platform_pushes rows, each with a `platform_contact_id`.

### S-GHL — Push 10,500 people to GHL in one shot
- **Link:** `/people?q=qa0818` (10,500 matched). Client **Internal**. Button
  **✉ Push to GHL**. On Confirm it should read **"8600 of 10500 eligible …
  1900 will be skipped"**. Tag `scale-ghl`.
- **Push (8600).** (voip 1000 + ghlmix-null 900 = 1900 skipped.)
- **Expect:** Total 10500, Created ~8600, Failed 0.
- **Verify:** `npx tsx .qa-tmp/verify-results.ts qa0818 ghl people 5` → expects
  **8600** platform_pushes rows.

> Run the **targeted tests below first** if you want clean first-time "Created"
> counts on the small slices; the scale push then re-touches them as "Updated."
> The DB verification (Part 5) counts every push row regardless, so order does
> not affect pass/fail — only the Created-vs-Updated label.

---

# PART 1 — EMAILBISON · PEOPLE (workspace ✉) — client "Testing"

Tests EB-1→EB-5 and EB-9→EB-12 all reuse the **MAIN** slice
(`/people?q=qa0818-ebmain`, 1500) so the re-push chain works. Run in order.

### EB-1 — Defaults + custom vars + Created count (1500)
- Partial update. Standard fields: **all 5 default**. Custom vars (Source=Column):
  `qa_city`←City, `qa_state`←State, `qa_employees`←Employees, `qa_tags`←Tags,
  `qa_phone`←Phone. **Push (1500).**
- Expect: 1500 **created**; Company = raw `Widgetworks Incorporated {n}` (fallback,
  not blank); `qa_tags` a JSON array string `["alpha","beta"]`; `qa_employees` a
  numeric string. Push Activity **Created 1500 / Updated 0 / Failed 0**.

### EB-2 — Re-push identical → Updated, no duplicates (1500)
- Same link + settings. **Push (1500).** Expect **Created 0 / Updated 1500**;
  EmailBison lead count unchanged.

### EB-3 — Re-push with ZERO custom vars → vars NOT wiped (1500)
- Same link. Remove all custom-var rows. **Push (1500).** Expect the `qa_*` vars
  from EB-1 **still present** (omit-on-empty).

### EB-4 — Static value on a standard field (1500)
- **Title → Static value → `QA-STATIC-TITLE`.** Others default. **Push (1500).**
  Expect Title = `QA-STATIC-TITLE` on all; First/Last/Email/Company still real.
- **EB-4b:** re-push, Title → Static value **blank** → Title empty, no `literal:`
  marker leak.

### EB-5 — Full replace (put) blanks an unsent field (1500)  ← "full rewrite"
- **Existing lead behavior = Full replace (put). Title → — ignore —.** **Push (1500).**
  Expect Title now **BLANK** on all (put cleared it). If it still shows the static
  title, put is broken.

### EB-9 — Multiple static custom vars (1500)
- 3 custom vars Source=Static: `qa_a`=AAA, `qa_b`=BBB, `qa_c`=CCC. **Push (1500).**
  Expect all three verbatim on every lead.

### EB-10 — Duplicate custom-var name (1500)
- Two rows named `qa_dup` — one Static `S`, one Column ← City. **Push (1500).**
  Record which wins (documentation case).

### EB-11 — Phone/Website are custom vars, not native (1500)
- Confirm the standard-field section shows **exactly 5 rows** (no native Phone/
  Website). Add `qa_phone2`←Phone. **Push (1500).** Expect it lands as a custom var.

### EB-12 — Invalid custom-var gating (1500)
- Blank-name row → Continue **disabled**. Fix name; add Static row with **empty
  value** → it is **silently dropped**. **Push (1500).**

### EB-6 — Cleaned brand wins over raw (BRAND, 1000)
- **Link:** `/people?q=qa0818-ebbrand`. Company name → default. **Push (1000).**
  Expect every lead Company = **`QA Brandtest`** (not `QA Brandtest Cosmetics LLC`).

### EB-7 — All-no-email → failure reason (NOEMAIL, 1000)
- **Link:** `/people?q=qa0818-ebnoemail`. Defaults. **Push (1000).**
  Expect **1000 failed** ("no email on record"), **0 created**.

### EB-8 — Mixed batch → partial success + reason persistence (MIXED, 1500)
- **Link:** `/people?q=qa0818-ebmixed`. Defaults. **Push (1500).**
  Expect Total 1500, **1000 created, 500 failed**, reasons still visible after run.

---

# PART 2 — EMAILBISON · CAMPAIGNS (🚀) — CAMP slice, client "Testing"

**Link (EB-13/14/15):** `/people?q=qa0818-ebcamp` (1500).

### EB-13 — Create campaign + A/B variant + "Just add leads" (1500)
- Campaign step → **+ Create** → name `QA-Campaign-A`, ≥1 sender, a schedule; add
  **1 step** (subject+body) + **+ Add split test variant** (Variant B subject+body).
  Options defaults. Launch step **Just add leads**. **Confirm (1500).**
- Expect: no 404; 1500 attach to `QA-Campaign-A`; A/B variant shows, no error.

### EB-14 — Re-push same people to SAME campaign → quiet no-op (1500)
- Same link. Campaign step: pick existing `QA-Campaign-A`. **Confirm (1500).**
  Expect ~1500 updated / **0 false failures**.

### EB-15 — Same people to a DIFFERENT campaign → conflict UI + parallel (1500)
- Same link. **+ Create `QA-Campaign-B`** (sender+schedule+1 step). On confirm,
  parallel **OFF**. Expect an amber **"1500 of 1500 already active in a different
  campaign"** warning + inline allow-parallel toggle. **Confirm (1500)** → all
  reported **failed with reason**, not silently joined to B.
- **EB-15b:** re-push to `QA-Campaign-B` with parallel **ON** → they attach; lead
  is now active in **both** campaigns.

### EB-16 — Launch guard: empty campaign must not launch (NOEMAIL, 1000)
- **Link:** `/people?q=qa0818-ebnoemail`. Campaign step: create `QA-Campaign-C`.
  Launch step **Add leads & launch**. **Confirm (1000).** Expect 0 attach (all
  no-email) → campaign **stays draft** (NOT launched).

---

# PART 3 — EMAILBISON · COMPANIES (company-native ✉) — client "Testing"

Button is on **/companies**.

### EB-C1 — Company pushed as its own lead (EMAIL, 1200)
- **Link:** `/companies?q=qa0818-ebcemail`. Partial update, defaults. **Push (1200).**
  Expect 1200 leads: Company = `Northwind Traders {n}`, **First = the company
  name**, **Last = literal `company last name`**, Title empty.

### EB-C2 — No-email company skipped + stale note (MIXED, 1500)
- **Link:** `/companies?q=qa0818-ebcmixed`. Defaults. **Push (1500).**
  Expect **800 created, 700 failed** (no email). **Flag check:** if the Push
  Activity note still says "…resolved to Y linked people…", that copy is **stale**
  under company-native push — record it.

### EB-C3 — Company bindable list omits person fields
- Open the /companies Options step (EMAIL slice). Confirm Source dropdowns don't
  offer person-only fields. Record what's offered. (No push.)

---

# PART 4 — GHL · PEOPLE (✉ Push to GHL) — client "Internal"

GHL is **People-only** (no company GHL push).

### G-1 — Eligibility split (MIXED, 1500 → 600 eligible)
- **Link:** `/people?q=qa0818-ghlmix`. On Confirm verify **"600 of 1500 eligible …
  900 will be skipped"**. Tag `ghl-mix-a`. **Push (600).**
  Expect Push Activity: Total 1500, Created 600, 0 failed (1500−600 = 900 skipped).
  The 600 pushed are the mobile ones (n ≤ 600).

### G-2 — Zero-eligible → push disabled (VOIP, 1000 → 0)
- **Link:** `/people?q=qa0818-ghlvoip`. Confirm shows **"0 of 1000 eligible"** and
  the **Push button is disabled**. Confirm you cannot enqueue. **(Do not push.)**

### G-3 — Defaults + company fallback + tag + Created (MAIN, 1500)
**Link (G-3→G-12):** `/people?q=qa0818-ghlmain` (1500, all mobile). Run in order.
- Standard defaults. Tag `ghl-a`. **Push (1500).** Expect Total 1500, Created 1500,
  0 failed; companyName = raw `Northgate Systems {n}`; tag `ghl-a` on all.

### G-4 — Re-push → Updated + dedupe-sync + tag append (1500) [highest risk]
- **City → Static → `SECOND-CITY`. Tag `ghl-b`. Push (1500).** Expect Created 0,
  Updated 1500; **no duplicate contacts**; City = `SECOND-CITY`; **both** `ghl-a`
  and `ghl-b` tags present (append, not replace).

### G-5 — Static standard field + `""` edge (1500)
- **City → Static → `QA-CITY`. Push (1500).** Expect City = `QA-CITY`.
- **G-5b:** re-push City → Static **blank** → sends `city:""` and **blanks City**.

### G-6 — Ignore a standard field leaves value untouched (1500)
- **Country → — ignore —. Push (1500).** Expect each contact's Country unchanged
  (not blanked, not string `"null"`).

### G-7 — Custom field, column source, drop-if-empty (1500)
- Requires a custom field on the "Internal" location. Map one custom field → City.
  **Recall city is null when `n % 3 == 0`.** **Push (1500).** Expect n%3≠0 → field
  = their city; **n%3==0 → field ABSENT** (not empty string). (~500 have null city.)

### G-8 — List / number stringification (1500)
- Map a custom field → Tags (list) and another → Employees (number). **Push (1500).**
  Expect list arrives as **`red, green, blue`** (comma-space, NOT JSON); number as
  its string. (Everything is sent as a string — a numeric/date-typed GHL field may 422.)

### G-9 — Static custom field + blank drop (1500)
- Custom field → Static → `qa-literal-test`. **Push (1500).** Expect literal on all.
- **G-9b:** Static **blank** → field **dropped** (contrast G-5b).

### G-10 — Empty / stale custom-field list
- Zero custom fields → mapping shows only 7 standard rows, no error. — or — add a
  field in GHL, reopen mapping **without reloading** → it's absent (cache); reload
  to see it. Record which you observed.

### G-11 — Tag edge cases (1500)
- Blank tag → no tag. Whitespace-only tag `"   "` → trimmed → no tag.

### G-12 — Mapping remembered per client
- Push once with a non-default mapping; reopen the dialog for the same client →
  prior choices pre-selected (not reset).

---

# PART 5 — VERIFICATION (for the subagent)

**You are verifying what a human just pushed.** Context you need:
- Seed source tag: `qa-push-plan-20260818`. EB client name **Testing**
  (`a8dfe6bc-dd09-4146-b628-fc0eacce34f3`), GHL client name **Internal**
  (`0c556239-1608-41fc-9fda-89196c55a56f`).
- Tool: **`.qa-tmp/verify-results.ts`** — run with `npx tsx` from the repo root
  (loads `.env.local`, service-role). It is **DB-authoritative**: `platform_pushes`
  is written only on a *successful* push and stores the platform's own returned
  lead/contact id, so its count == what actually landed. It also does a best-effort
  live API sample (EB `GET {workspace}/api/leads/{id}`, GHL `GET /contacts/{id}`).

### Command per slice

```
# usage: verify-results.ts <token> <emailbison|ghl> [people|companies] [sampleSize]
npx tsx .qa-tmp/verify-results.ts qa0818-ebmain    emailbison people 5
npx tsx .qa-tmp/verify-results.ts qa0818-ebbrand   emailbison people 5
npx tsx .qa-tmp/verify-results.ts qa0818-ebmixed   emailbison people 5
npx tsx .qa-tmp/verify-results.ts qa0818-ebcamp    emailbison people 5
npx tsx .qa-tmp/verify-results.ts qa0818-ebcemail  emailbison companies 5
npx tsx .qa-tmp/verify-results.ts qa0818-ebcmixed  emailbison companies 5
npx tsx .qa-tmp/verify-results.ts qa0818-ghlmix    ghl people 5
npx tsx .qa-tmp/verify-results.ts qa0818-ghlmain   ghl people 5
# the 10k scale checks:
npx tsx .qa-tmp/verify-results.ts qa0818           emailbison people 8
npx tsx .qa-tmp/verify-results.ts qa0818           ghl people 8
```

### Expected `platform_pushes` recorded count (PASS = recorded == expected)

| Command | Expected recorded |
|---|---|
| qa0818-ebmain emailbison | 1500 |
| qa0818-ebbrand emailbison | 1000 |
| qa0818-ebnoemail emailbison | **0** (all no-email → all failed) |
| qa0818-ebmixed emailbison | 1000 |
| qa0818-ebcamp emailbison | 1500 |
| qa0818-ebcemail emailbison companies | 1200 |
| qa0818-ebcmixed emailbison companies | 800 |
| qa0818-ghlmix ghl | 600 |
| qa0818-ghlvoip ghl | **0** (disabled — nothing pushed) |
| qa0818-ghlmain ghl | 1500 |
| **qa0818 emailbison (SCALE)** | **9000** |
| **qa0818 ghl (SCALE)** | **8600** |

### What to report per slice
1. **Count:** recorded vs expected (from the table). Flag any gap.
2. **Field integrity:** the script prints a SAMPLE with the *expected* derived
   values (first/last/company/title/city/employees/tags) and, when the live API
   sample succeeds, the *actual* platform values. Confirm they match. For the
   BRAND slice, confirm Company = `QA Brandtest`. For company slices, confirm the
   native shape (First = company name, Last = `company last name`).
3. **Test-specific expectations** from the Results Log below (e.g. EB-5 blanks
   Title, G-4 appends both tags, EB-C2 stale note). Cross-check the pusher's notes.
4. Produce a single PASS/FAIL table mirroring the Results Log.

If the live API sample is skipped (auth/endpoint), the DB count + sample id list
is still authoritative — report the count result and list a few `platform_contact_id`s
for manual spot-check in the platform UI.

---

# PART 6 — TEARDOWN (Supabase only)

When verification is done:
```
npx tsx .qa-tmp/teardown.ts
```
Deletes all `source = 'qa-push-plan-20260818'` people + companies and their
`platform_pushes` / `push_job_records` (FK-safe order), then asserts 0 remain.
Finally remove the `.qa-tmp/` folder. (EB/GHL test leads are left as-is by design.)

---

# RESULTS LOG — pusher fills this; verifier reads it

## Scale
| Test | Link | Expected | Observed Push N | Created | Failed | Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|
| S-EB | q=qa0818 | 10500 → ~9000 created / ~1500 failed | | | | | |
| S-GHL | q=qa0818 | 10500 → ~8600 created / 0 failed | | | | | |

## EmailBison people
| Test | Expected N | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| EB-1 | 1500 | | | |
| EB-2 | 1500 | | | |
| EB-3 | 1500 | | | |
| EB-4 | 1500 | | | |
| EB-5 | 1500 | | | |
| EB-6 | 1000 | | | |
| EB-7 | 1000 | | | |
| EB-8 | 1500 | | | |
| EB-9 | 1500 | | | |
| EB-10 | 1500 | | | |
| EB-11 | 1500 | | | |
| EB-12 | 1500 | | | |

## EmailBison campaigns / companies
| Test | Expected N | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| EB-13 | 1500 | | | QA-Campaign-A |
| EB-14 | 1500 | | | same-campaign no-op |
| EB-15 | 1500 | | | QA-Campaign-B conflict |
| EB-16 | 1000 | | | QA-Campaign-C launch guard |
| EB-C1 | 1200 | | | company-native shape |
| EB-C2 | 1500 | | | 800 created / 700 failed + stale note |
| EB-C3 | — | | | bindable list |

## GHL
| Test | Expected (matched / eligible) | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| G-1 | 1500 / 600 | | | tag ghl-mix-a |
| G-2 | 1000 / 0 (disabled) | | | |
| G-3 | 1500 / 1500 | | | tag ghl-a |
| G-4 | 1500 / 1500 | | | dedupe + tag append |
| G-5 | 1500 / 1500 | | | static + "" edge |
| G-6 | 1500 / 1500 | | | ignore untouched |
| G-7 | 1500 / 1500 | | | drop-if-empty (~500 null city) |
| G-8 | 1500 / 1500 | | | list/number stringify |
| G-9 | 1500 / 1500 | | | static custom + blank drop |
| G-10 | — | | | empty/stale custom list |
| G-11 | 1500 / 1500 | | | tag trim |
| G-12 | 1500 / 1500 | | | mapping persistence |
