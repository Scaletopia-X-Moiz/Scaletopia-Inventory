# EmailBison Push — Live Manual Test Plan (first-run, real data)

Base site: **https://inventory.scaletopia.io**

> **This supersedes the old seed-based version.** The `claude-qa-2026-08` seed was
> cleaned up 2026-08-17, so every link below targets **real production data**
> with counts measured live on 2026-08-17. Pushing these creates **real leads in
> your EmailBison workspace** — use a client/workspace you're OK polluting, and
> plan cleanup.

## Read this first — three facts the old plan got wrong

1. **There are 5 native standard fields, not 7:** **Company name, First name,
   Last name, Email, Title**. **Phone and Website are NOT native** — they only
   reach EmailBison as *custom variables* bound to the phone/website columns.
   (`lib/emailbison/client.ts` `toWireLead` sends `email, first_name, last_name,
   company, title` + `custom_variables`.)
2. **Company push is company-native (ADR 0005 reversed 0003):** each matched
   company is pushed as *its own lead* (email = the company's own email, company
   = its own name, first = raw name, last = literal `"company last name"`, title
   skipped). It no longer resolves to linked people. The only skip reason is a
   company with **no email of its own**.
3. **Push Activity's company completion note still says "…resolved to Y linked
   people…"** — that copy is stale under company-native push. Treat it as a
   **known suspected bug** to confirm, not as expected behavior (test EB-C2).

## The push dialog (what the settings mean)

Plain push (**Add to EmailBison**, ✉) — 3 steps:
1. **Client** — pick one with EmailBison creds. **Use the SAME client for every
   test below** (dedupe/created-vs-updated only make sense within one workspace).
2. **Options:**
   - **Existing lead behavior:** **Partial update (patch)** = only sends mapped
     fields, leaves the rest alone (default). **Full replace (put)** = blanks any
     native field you did NOT send.
   - **Standard field mapping** — the 5 native fields. Each **Source** = a record
     column / **Static value** (literal text) / **— ignore —** (skip).
   - **Custom variables** — add rows: **Name** + **Source** (Column / Static
     value) + value.
3. **Confirm** — the **Push {N}** button. **{N} must equal the Expected count.**

Campaign push (**Add to EmailBison Campaign**, 🚀) inserts a **Campaign** step
(pick/create) and a **launch** step.

## Safety

- **No row-selection: a push sends ALL filter-matched rows**, regardless of which
  page is visible. The count shown on the page = what will be pushed (before the
  no-email skip). **If Push {N} ≠ Expected, STOP and don't confirm.**
- Track results in **/push-activity** (queued, not instant), then verify in
  EmailBison itself.
- Log your observed **Push {N}** in the results table at the bottom — the
  verification subagent reads it.

---

# SEQUENCE 1 — People: field mapping, custom vars, created/updated

**All of Sequence 1 uses ONE slice so the re-push tests chain cleanly.**
**Link:** https://inventory.scaletopia.io/people?country=AU&email=not_empty
**Expected: 15 people** (all have an email; all linked to companies with **null
brand_name** → raw-name fallback). Button: **Add to EmailBison** (✉).

### EB-1 — First push: defaults + custom vars + Created count
Guards default field resolution, brand→raw fallback, column custom vars,
array/number stringification, created-count heuristic.
- Existing lead behavior: **Partial update**.
- Standard fields: **leave all 5 at defaults**.
- Custom variables — add 5 rows, **Source = Column**:
  - `qa_city` ← **City**
  - `qa_state` ← **State**
  - `qa_domain` ← **Domain** (company domain)
  - `qa_employees` ← **Employees** (company employee count — a number)
  - `qa_tags` ← **Tags** (an array column)
- **Push (15).**
- Verify in EmailBison: 15 leads created; open 3 →
  - **Company = the raw `company_name`** (fallback fired; **no blank company**),
  - all 5 custom vars present & non-empty,
  - `qa_employees` is a numeric string, `qa_tags` is a **JSON array string**
    (`["a","b"]`), not `[object Object]`.
- Push Activity: **Created 15 / Updated 0 / 0 failed**.

### EB-2 — Re-push identical → Created→Updated, no duplicates
Guards the created/updated DB heuristic and email-upsert dedupe.
- Same link, **same settings as EB-1**. **Push (15).**
- Push Activity: **Created 0 / Updated 15.** EmailBison lead count **unchanged**
  (no duplicate leads).

### EB-3 — Re-push with ZERO custom vars → vars must NOT be wiped
Guards the `custom_variables` omit-on-empty rule (explicit `[]` would clear all).
- Same link. Partial update. Standard defaults. **Remove all custom-var rows.**
  **Push (15).**
- Verify in EmailBison: the `qa_*` variables from EB-1 are **still present** on
  the leads (they were left alone, not blanked).

### EB-4 — Static value on a standard field (+ blank edge)
Guards the literal-source decode path.
- Same link. Partial update. **Title → Source = Static value → `QA-STATIC-TITLE`.**
  Others default. **Push (15).**
- Verify: all 15 have **Title = `QA-STATIC-TITLE`**; First/Last/Email/Company
  still show real per-lead values.
- **EB-4b (edge):** re-push, Title → Static value **left blank** → Title should
  be **empty**, no error, and **no** `literal:` marker string.

### EB-5 — Full replace (put) blanks an unsent field
Guards patch-vs-put semantics.
- Same link. **Existing lead behavior = Full replace (put).** **Title → — ignore —.**
  Others default. **Push (15).**
- Verify: **Title is now BLANK** on all 15 (put cleared the field you didn't
  send). If Title still shows `QA-STATIC-TITLE`, put is broken.

---

# SEQUENCE 2 — People: brand name preferred over raw

**Link:** https://inventory.scaletopia.io/people?q=revitalash.com
**Expected: 4 people**, all linked to a company whose **raw name is
`RevitaLash Cosmetics`** but **cleaned `brand_name` is `RevitaLash`**. Button: ✉.

### EB-6 — Cleaned brand wins when present
Guards `companyName ← brandName` preferring the cleaned brand.
- Partial update. **Company name → default (brandName).** **Push (4).**
- Verify in EmailBison: every lead's **Company = `RevitaLash`** (cleaned brand),
  **not** `RevitaLash Cosmetics` (the raw name). That difference is the whole test.

---

# SEQUENCE 3 — People: no-email + mixed batch failure reporting

### EB-7 — All-no-email → per-lead failure reason
**Link:** https://inventory.scaletopia.io/people?email=empty&country=AU
**Expected: 20 people, all with NO email.** Button: ✉.
- Defaults, Partial update, no custom vars. **Push (20).**
- Verify Push Activity: **20 failed**, each `{name} — no email on record`.
  **0 leads** created in EmailBison.

### EB-8 — Mixed batch → partial success + counts + reason persistence
**Link:** https://inventory.scaletopia.io/people?industry=oil%20and%20gas
**Expected: 84 people = 55 with email + 29 with no email.** Button: ✉.
- Defaults, Partial update. **Push (84).**
- Verify Push Activity: **Total selected 84**, **~55 created, 29 failed**, each
  failure showing the no-email reason, and reasons **still visible after the run
  finishes** (not lost between worker ticks).

---

# SEQUENCE 4 — People: custom-variable edge cases

**Reuse Link:** https://inventory.scaletopia.io/people?country=AU&email=not_empty (15).

### EB-9 — Multiple static custom vars at once
- Partial update. Add 3 custom vars, **Source = Static value**, distinct names:
  `qa_a`=`AAA`, `qa_b`=`BBB`, `qa_c`=`CCC`. **Push (15).**
- Verify: all 3 present verbatim on every lead (none dropped, none overwrite
  each other).

### EB-10 — Duplicate custom-var name (document behavior)
- Add two rows both named `qa_dup` — one Static `S`, one Column ← City. **Push.**
- Verify which value wins on the wire and record it (EmailBison decides
  last-wins; this is a "document the actual behavior" case).

### EB-11 — Phone/Website are custom vars, not native (C-1 audit)
- Add `phone` ← **Phone** column and `website` ← **Website** column.
- **First confirm the dialog's standard-field section shows exactly 5 rows**
  (Company/First/Last/Email/Title) — **no native Phone or Website row.**
- **Push.** Verify `phone`/`website` land as EmailBison **custom variables**.

### EB-12 — Invalid custom-var row gating
- Add a row with a **blank name** → **Continue must be disabled** with a hint.
- Fix the name; add a **Static** row with an **empty value** → it should be
  **silently dropped** from the push (not block, not error).

---

# SEQUENCE 5 — Companies: company-native push (ADR 0005)

### EB-C1 — Company pushed as its own lead
**Link:** https://inventory.scaletopia.io/companies?country=BH&email=not_empty
**Expected: 16 companies, all with their own email.** Button: **Add to
EmailBison** (✉, on /companies).
- Partial update, defaults. **Push (16).**
- Verify in EmailBison: **16 leads created**, each with **Company = the company's
  own name**, **First name = raw company name**, **Last name = literally
  `company last name`**, Title empty. (This is the company-native shape — a
  person-shaped mapping here would be the bug.)

### EB-C2 — Company with no email skipped + stale "linked people" note
**Link:** https://inventory.scaletopia.io/companies?country=BH
**Expected: 32 companies = 16 with email + 16 with none.** Button: ✉.
- Partial update, defaults. **Push (32).**
- Verify: **16 created, 16 failed** with a "no email" reason.
- **Flag check (suspected bug):** read the Push Activity completion note. Under
  company-native push it **should** attribute the gap to companies-with-no-email
  being skipped. If it still says **"…resolved to Y linked people…"** /
  "companies with no linked people contribute nothing", **that wording is stale**
  — note it for the bug report.

### EB-C3 — Company bindable-column list omits person fields
- Open the /companies push **Options** step. Verify the standard-field Source
  dropdowns do **not** offer First name / Last name / Title as *record* columns
  in the person sense (company-specific bindable list). Record what's offered.

---

# SEQUENCE 6 — People: campaigns (🚀)

**All of Sequence 6 uses ONE fresh all-email slice.**
**Link:** https://inventory.scaletopia.io/people?country=AE&email=not_empty
**Expected: 9 people** (all have email). Button: **Add to EmailBison Campaign** (🚀).

### EB-13 — Create campaign + A/B variant + "Just add leads"
Guards campaign create orchestration, sequence variant linking, auto-upsert of
never-pushed candidates.
- **Campaign step: + Create a campaign** → name `QA-Campaign-A`, pick ≥1 sender,
  set a schedule; add **1 step** (subject + body) and **+ Add split test variant**
  (fill Variant B subject + body — this exercises the A/B linking).
- Options: defaults, Partial update.
- Launch step: **Just add leads** (not launch).
- **Confirm (9).**
- Verify: no 404 on create; **9 leads attach to `QA-Campaign-A`**; the campaign
  shows the A/B variant step in EmailBison with no error.

### EB-14 — Re-push SAME people to SAME campaign → quiet no-op
Guards the `campaign_tag` skip (the fix for false "failed" reports).
- Same link. **Campaign step: pick existing `QA-Campaign-A`.** **Confirm (9).**
- Verify Push Activity: **~9 updated / 0 failed**, **no false "failed" rows**,
  and no re-attach errors.

### EB-15 — Same people to a DIFFERENT campaign → real failures + conflict UI
Guards already-in-another-campaign reporting, the pre-flight conflict warning,
and the allow-parallel toggle (the most recently churned code).
- Same link. **Campaign step: + Create `QA-Campaign-B`** (sender + schedule + 1
  step). Options defaults. **On the confirm step, parallel sending OFF.**
- Verify the confirm step shows an **amber warning** like "**9 of 9 already look
  active in a different campaign**" with an inline **allow-parallel toggle**.
- **Confirm (9).** Verify: the 9 are reported **failed with a reason** (e.g.
  "already in a campaign"), **not** "9 queued, 0 failed", and they do **not**
  silently join Campaign B.
- **EB-15b:** re-push the same 9 to `QA-Campaign-B` with **parallel ON** → they
  should now attach; verify in EmailBison the lead is active in **both**
  campaigns.

### EB-16 — Launch guard: empty campaign must not launch
Guards the `succeeded >= 1` auto-launch gate.
- **Link:** https://inventory.scaletopia.io/people?email=empty&country=AU (20, all
  no-email). Campaign step: create `QA-Campaign-C`. Launch step: **Add leads &
  launch**. **Confirm (20).**
- Verify: 0 attach (all no-email) → the campaign is **NOT launched** (stays
  draft). A launched-but-empty campaign is the failure.

---

# SEQUENCE 7 — Cross-workspace (OPTIONAL — needs a 2nd EB client/workspace)

Only run if you have a second client whose EmailBison creds point at a
**different workspace**.

### EB-X1 — Campaign lists are per-client
- Open the campaign picker for Client A, then Client B → each shows **its own
  workspace's** campaigns only (no bleed).

### EB-X2 — Same campaign name in two workspaces stays independent
- Create `QA-Campaign` in both workspaces; push the same people to each →
  independent attach records; the conflict-check for A must **not** flag B's
  membership (dedupe is by campaign **id**, never name).

---

## Coverage map

| # | Guards | Failure symptom |
|---|--------|-----------------|
| EB-1 | defaults, brand→raw fallback, column vars, stringify, created count | blank company; var empty; `[object Object]`; miscount |
| EB-2 | created/updated heuristic, dedupe | re-push re-counts as created / dup leads |
| EB-3 | `custom_variables` omit-on-empty | re-push wipes existing vars |
| EB-4 | static-value standard field | blank / `literal:` marker leak |
| EB-5 | patch vs put | put doesn't blank the unsent field |
| EB-6 | brand preferred over raw | raw name sent instead of cleaned brand |
| EB-7 | no-email failure reason | bare name / no reason / silent |
| EB-8 | mixed batch counts + reason persistence | Total 0; reasons lost mid-run |
| EB-9 | multiple static vars | a var dropped / overwritten |
| EB-10 | duplicate var name | (documentation case) |
| EB-11 | phone/website are custom vars (5 native only) | native phone/website row exists |
| EB-12 | invalid-row gating | blank-name not blocked; empty static not dropped |
| EB-C1 | company-native shape | person-shaped mapping / blank last name |
| EB-C2 | company no-email skip + note wording | still says "linked people" |
| EB-C3 | company bindable list | person-only fields offered |
| EB-13 | campaign create + variant + auto-upsert | 404; variant error; leads never attach |
| EB-14 | same-campaign no-op (`campaign_tag`) | duplicates reported as failed |
| EB-15 | other-campaign failures + conflict UI + parallel | silent drop; missing warning; toggle ignored |
| EB-16 | launch guard | empty campaign launched |
| EB-X1/X2 | per-client cache / id-based dedupe | cross-workspace bleed |

## Needs different setup / not UI-testable (do not attempt from the UI)
- **>15 custom variables** (reference-panel pagination + re-create bug) — needs
  such a workspace.
- **>15 sender mailboxes** (sender-picker pagination) — needs such a workspace.
- Retry/backoff on 429/5xx; worker resumability on very large (multi-tick)
  batches; stranded-job reaper; cron/worker-secret gating — infra, only
  indirectly visible as Push Activity stalls/progress.
- Legacy saved-mapping normalization — needs a pre-existing legacy
  `push_field_mappings` row.
- Per-candidate write-back failure / chunk-failure isolation — can't force from
  the UI.

## Results log (fill as you go — the verification subagent reads this)

| Test | Expected N | Observed Push N | Pass/Fail | Notes |
|------|-----------|-----------------|-----------|-------|
| EB-1 | 15 | | | |
| EB-2 | 15 | | | |
| EB-3 | 15 | | | |
| EB-4 | 15 | | | |
| EB-5 | 15 | | | |
| EB-6 | 4 | | | |
| EB-7 | 20 | | | |
| EB-8 | 84 | | | |
| EB-9 | 15 | | | |
| EB-10 | 15 | | | |
| EB-11 | 15 | | | |
| EB-12 | 15 | | | |
| EB-C1 | 16 | | | |
| EB-C2 | 32 | | | |
| EB-C3 | — | | | |
| EB-13 | 9 | | | |
| EB-14 | 9 | | | |
| EB-15 | 9 | | | |
| EB-16 | 20 | | | |
