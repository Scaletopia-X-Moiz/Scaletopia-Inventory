# EmailBison Push — Live Manual Test Plan (elaborated)

Base site: **https://inventory.scaletopia.io**
Seed data (live): **10,400 people + 525 companies**, all tagged
`source_tokens = "claude-qa-2026-08"`, emails/domains end `@claude-qa.example`.

## The push dialog (what the settings mean)

Every plain push (**Add to EmailBison**, ✉ icon) has 3 steps:
1. **Client** — pick one with EmailBison creds (use the SAME one every run).
2. **Options**, three parts:
   - **Existing lead behavior:** **Partial update (patch)** = only sends the
     fields you mapped, leaves others alone. **Full replace (put)** = blanks any
     field you did NOT send. *Default = Partial.*
   - **Standard field mapping** — 7 EmailBison destination fields
     (**Company name, First name, Last name, Email, Phone, Title, Website**).
     Each has a **Source** dropdown: a record column, a **Static value** (type
     literal text), or **Skip**.
   - **Custom variables** — add rows: **Name** (the EmailBison variable) +
     **Source** (Static value / Column) + value.
3. **Confirm** — the **Push {N}** button. **{N} must match the Expected count.**

Campaign push (**Add to EmailBison Campaign**, 🚀 icon) adds a **Campaign** step
(pick/create) and a **launch** step.

## Safety
- Every link contains `source=claude-qa-2026-08` → only test data. Keep it.
- No row-selection: a push sends ALL filter-matched rows. **If Push {N} ≠
  Expected, STOP.**
- Track results in **/push-activity** (queued, not instant), then EmailBison.

## Cleanup when done
`node .scratch/seed-qa-people.mjs --cleanup`

---

# PEOPLE scenarios (`/people`)

## S1 — All new columns populate + Created→Updated
**Guards `6726848` (new bindable columns), `c8f7bdc` (created/updated split).**
Symptom if broken: new column is in the dropdown but arrives empty; or re-push
counts everything as "created" again.

**Link:** https://inventory.scaletopia.io/people?source=claude-qa-2026-08&industry=software%20development
**Expected: 1000 people. Button: Add to EmailBison.**

Set in the dialog:
- Existing lead behavior: **Partial update**.
- Standard fields: leave defaults (Company name ← brandName, First/Last/Email/
  Phone/Title/Website ← their own columns).
- Custom variables — add these 4 rows (Source = **Column**):
  - `qa_city` ← **City**
  - `qa_state` ← **State**
  - `qa_company_domain` ← **Domain** (company domain)
  - `qa_employees` ← **Employees** (company employee count)
- Push (1000).

Check in EmailBison:
1. 1000 leads created.
2. Open any 3 leads → all four custom variables present & non-empty:
   `qa_city` is a real city (Austin/London/…), `qa_state` matches it,
   `qa_company_domain` ends `.claude-qa.example`, `qa_employees` is a number.
3. Push Activity: **Created 1000 / Updated 0**.
4. **Re-push the exact same link, same settings** → Push Activity now shows
   **Created 0 / Updated 1000** (no duplicate leads in EmailBison).

## S2 — Static value on a standard field
**Guards `037a49a` (static value must not be treated as a column).**
Symptom if broken: Title arrives blank or with a literal column key.

**Link:** https://inventory.scaletopia.io/people?source=claude-qa-2026-08&industry=software%20development&country=GB
**Expected: 100 people. Button: Add to EmailBison.**

Set:
- Existing lead behavior: **Partial update**.
- Standard fields: **Title → Source = Static value → type `QA-STATIC-TITLE`**.
  Leave the other 6 at defaults.
- No custom variables.
- Push (100).

Check in EmailBison:
1. All 100 leads have **Title = `QA-STATIC-TITLE`** (identical on every one).
2. First/Last/Email/Company still show the leads' real values (only Title was
   overridden).

**S2b (edge):** repeat, but set Title Static value **blank** → push → Title
should be **empty**, no error, and NOT show a literal like `literal:` or a
column name.

## S3 — Partial update vs Full replace (put blanks unsent fields)
**Guards patch/put semantics.** Symptom if broken: Full replace doesn't clear a
skipped field (or Partial wrongly clears fields).
This is a **two-push** test on the same slice.

**Link:** https://inventory.scaletopia.io/people?source=claude-qa-2026-08&country=CA
**Expected: 1000 people (all Toronto). Button: Add to EmailBison.**

Push A — seed a value:
- Existing lead behavior: **Partial update**.
- Standard fields: **Title → Static value → `TITLE-CA`**. Others default.
- Push (1000). → all 1000 leads get **Title = TITLE-CA**.

Push B — full replace with Title skipped:
- Open the **same link**.
- Existing lead behavior: **Full replace (put)**.
- Standard fields: **Title → Skip**. Others default.
- Push (1000).

Check in EmailBison:
1. After Push B, **Title is now BLANK** on all 1000 (Full replace cleared the
   field you didn't send). If Title still says `TITLE-CA`, put is broken.
2. **Filter-integrity check:** every one of the 1000 leads is in **Toronto** /
   Canada. If any London/Austin/other-country lead appears, the `country=CA`
   filter leaked.

## S4 — Uncleaned company → RAW name fallback (highest risk)
**Guards `7942be4` / `1a9bbce` (companyName←brandName must fall back to raw name
when there's no cleaned brand).** Symptom if broken: Company arrives **blank**
for nearly every lead.

**Link:** https://inventory.scaletopia.io/people?source=claude-qa-2026-08&niche=qa-uncleaned
**Expected: 300 people (linked companies have brand_name = null).**

Set:
- Existing lead behavior: **Partial update**.
- Standard fields: **Company name → Source = brandName** (the default — leave it).
- Push (300).

Check in EmailBison:
1. Every lead's **Company = `Raw Uncleaned Co NNNN`** (the raw name).
2. **No lead has a blank Company.** A single blank one = the fallback regressed.

## S5 — Cleaned company → BRAND name preferred
**Guards `7942be4` / `1a9bbce` (cleaned brand wins when present).**
Symptom if broken: raw `QA Company` sent instead of cleaned `QA Brand`.

**Link:** https://inventory.scaletopia.io/people?source=claude-qa-2026-08&industry=retail&country=DE
**Expected: 100 people (linked companies ARE cleaned).**

Set:
- Existing lead behavior: **Partial update**.
- Standard fields: **Company name → Source = brandName** (default).
- Push (100).

Check in EmailBison:
1. Every lead's **Company = `QA Brand NNNN`** (cleaned).
2. **None** show `QA Company NNNN` (that would mean it sent the raw name).

## S6 — No-email leads → per-lead failure reason
**Guards `f56f3ca` / `9539058` (report the real reason, not a bare name).**
Symptom if broken: shows just a name, or a misleading "queued/0 failed".

**Link:** https://inventory.scaletopia.io/people?source=claude-qa-2026-08&niche=qa-noemail
**Expected: 100 people, all with NO email. Button: Add to EmailBison.**

Set: defaults, Partial update, no custom vars. Push (100).

Check:
1. **Push Activity** shows **100 failed**, each as `{name} — no email on record`
   (or equivalent specific reason).
2. **Nothing** lands in EmailBison (0 leads created).

## S7 — Mixed batch → partial success + counts
**Guards `f56f3ca`, `c8f7bdc` (Total selected ≠ 0), `3df7cf0` (failure reasons
persist across ticks).** Symptom if broken: Total selected shows 0, or the 100
failure reasons are lost after the run.

**Link:** https://inventory.scaletopia.io/people?source=claude-qa-2026-08&industry=hospitality
**Expected: 1100 = 1000 valid + 100 no-email. Button: Add to EmailBison.**

Set: defaults, Partial update. Push (1100).

Check:
1. Push Activity: **Total selected 1100**, **~1000 succeeded, 100 failed**, each
   failure with the no-email reason (reasons still visible after it finishes).
2. EmailBison gets ~1000 leads.

---

# COMPANIES scenarios (`/companies`)

A company push resolves to the **people linked to those companies** (EmailBison
has no company object). Each seeded company links to 20 people.

## S8 — Company → linked-people resolution shown
**Guards `4fc02df` (surface "X companies → Y people").**
Symptom if broken: the company/people gap isn't explained.

**Link:** https://inventory.scaletopia.io/companies?source=claude-qa-2026-08&country=GB
**Expected: 50 companies → 1000 linked people. Button: Add to EmailBison.**

Set:
- Existing lead behavior: **Partial update**.
- Standard fields: leave defaults. Optionally add a custom variable
  `qa_industry ← Industry` (company industry) to confirm company columns resolve
  on a company-side push.
- Push.

Check:
1. **Push Activity** reads *"50 companies selected → 1000 linked people sent"*.
2. 1000 leads in EmailBison; if you set `qa_industry`, it's populated.

## S9 — Company push with ZERO linked people
**Guards `4fc02df` (explicit 0-people message, not a silent 0/0).**
Symptom if broken: looks like a broken 0/0 push.

**Link:** https://inventory.scaletopia.io/companies?source=claude-qa-2026-08&niche=qa-orphan-nopeople
**Expected: 10 companies → 0 linked people. Button: Add to EmailBison.**

Set: defaults. Push.

Check:
1. Push Activity explicitly says **10 companies → 0 linked people** with a "no
   linked people" explanation.
2. Nothing pushed. It must NOT read as a silent/failed 0/0.

---

# CAMPAIGN scenarios (`/people`)

## S10 — New campaign attach, then already-in-campaign failure
**Guards `1d9fdb3` (variant contract), `444fe87` (leads already active in another
campaign reported as REAL failures, not silent no-ops).**
Symptom if broken: campaign create 404s; or the second push says "100 queued, 0
failed" while those leads never actually attach.

**Link:** https://inventory.scaletopia.io/people?source=claude-qa-2026-08&industry=education&country=US
**Expected: 100 people. Button: Add to EmailBison Campaign (🚀).**

Push A — create + attach:
- Campaign step: **+ Create a campaign** → name `QA Campaign A`, pick a sender,
  set a schedule; (optional) add a **sequence step + A/B variant** to exercise
  `1d9fdb3`.
- Options: defaults, Partial update.
- Launch step: **Just add leads**.
- Confirm (100).

Check A:
1. No 404 creating the campaign.
2. Push Activity: 100 attached; the 100 leads appear in `QA Campaign A` in
   EmailBison.
3. If you added a variant: the campaign shows the A/B variant step (variant marked
   on the second step, pointing at the base step — no error).

Push B — same leads, different campaign:
- Open the **same link**. Campaign step: **create `QA Campaign B`**.
- Confirm (100).

Check B:
1. Because the 100 are already active in Campaign A, EmailBison no-ops them — the
   fix must report them as **failed with a reason** per lead (e.g. "already in a
   campaign"), NOT "100 queued, 0 failed".
2. They do NOT get silently added to Campaign B.

---

## Coverage map

| # | Guards | Failure symptom |
|---|--------|-----------------|
| S1 | `6726848`, `c8f7bdc` | new column empty; re-push re-counts as created |
| S2 | `037a49a` | static value blank / column-key leak |
| S3 | patch/put | Full replace doesn't blank skipped field |
| S4 | `7942be4`,`1a9bbce` | uncleaned company name blank |
| S5 | `7942be4`,`1a9bbce` | raw name sent instead of brand |
| S6 | `f56f3ca`,`9539058` | failure shows bare name, no reason |
| S7 | `c8f7bdc`,`3df7cf0` | Total selected 0; reasons lost mid-run |
| S8 | `4fc02df` | company→people count not surfaced |
| S9 | `4fc02df` | silent 0/0 |
| S10 | `1d9fdb3`,`444fe87` | variant 404; already-in-campaign silently dropped |

## Needs a different setup (not in this seed)
- Custom-var cache-key-per-client (`6ef7e3a`) — two clients / two EB workspaces.
- Sender-email & custom-var pagination (`248efff`,`6ef7e3a`) — >15 mailboxes/vars.
- Stranded-job reaper / cron whitelist (`08a5938`,`75261a0`) — infra, not UI-observable.
