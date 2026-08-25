# GHL Push — Live Manual Test Plan (first-run, real data)

Base site: **https://inventory.scaletopia.io**

> Links target **real production data** (measured live 2026-08-17). Pushing these
> creates **real contacts in a GHL location**. **Use your Internal / Testing
> client** (a throwaway GHL sub-account) for every test — there is **no
> programmatic "test" flag**; you must recognize it **by name** in the client
> picker. Do not push to a live-client location.

## Read this first — four facts the old plan / prior notes got wrong

1. **Push Activity does NOT show eligible/skipped/pushed.** It shows exactly
   **Total selected, Created, Updated, Failed** (+ up to 5 failure reasons).
   `Total selected` = the whole matched set *including* ineligible rows;
   `pushed = Created + Updated`; skipped is only `Total − Created − Updated −
   Failed`, never labeled. **Read the eligible/skipped split from the CONFIRM
   dialog**, not Push Activity.
2. **A blank Static value on a STANDARD field is sent as `""`, not omitted** — so
   on a duplicate/update it can **blank an existing GHL value**. (A blank static
   on a *custom* field IS dropped — opposite behavior. Test both.)
3. **Field mapping is now remembered per (client, "ghl")** and reloads on the
   next open — earlier notes said it never remembers; that's outdated.
4. **The custom-fields fetch has no pagination** — a GHL location with >100
   custom fields likely only exposes the first page. Treat as a suspected defect,
   not just "needs setup".

GHL push is **People-only** — there is no company-native GHL push (the button
only exists on `/people`). No `/companies` steps here.

## The push dialog (what the settings mean)

**✉ Push to GHL** (on `/people`) — 3 steps:
1. **Client** — pick one with GHL creds configured (credential-less clients are
   greyed out). **Use your Internal/Testing client** and keep it the **same**
   across a before/after pair.
2. **Map fields for GHL:**
   - **Standard fields** (Company name, First name, Last name, Email, Phone,
     City, Country) — each Source = a column / **Static value** / **— ignore —**.
     Company name defaults to cleaned brand with raw-name fallback.
   - **Custom fields** — one row per custom field on that client's GHL location.
     Source = **Column** / **Static value** / **— ignore —**.
3. **Confirm** — shows **{eligible} of {total_matched} eligible (mobile /
   toll-free)** + a skipped count, a single free-text **Tag**, and **Push {N}**.
   **{N} must equal the eligible count.**

## Safety

- **No row-selection: a push sends every filter-matched, phone-eligible row.**
  Only `phone_type ∈ {mobile, toll_free}` is pushed; landline / voip / fixed_line
  / null are skipped and counted separately. **If Push {N} ≠ the eligible count
  you expect, STOP.**
- **Note (this data set):** `toll_free` does not occur, so eligible == `mobile`.
  All ineligible rows in the small slices below are **null phone_type**.
- Track results in **/push-activity**, then in GHL (Contacts → search by email;
  Settings → Custom Fields to confirm a field id).

---

# SEQUENCE A — Eligibility gate

### G-1 — Mixed slice: eligible vs skipped split (read from confirm dialog)
**Link:** https://inventory.scaletopia.io/people?country=INDIA
**Expected: 18 matched → 4 eligible (mobile), 14 skipped (null phone).**
- Open **Push to GHL**. On **Confirm**, verify it reads **"4 of 18 eligible …
  14 will be skipped"**. **Push (4).**
- After it runs, verify in Push Activity: **Total selected 18**, **Created 4**
  (first-time), Updated 0, Failed 0 → so `Total − Created − Updated − Failed =
  14` accounts for the skipped. Spot-check 2 pushed contacts in GHL — neither
  should be one you can confirm had a null/landline phone.

### G-2 — Zero-eligible slice: push disabled
**Link:** https://inventory.scaletopia.io/people?phoneType=voip
**Expected: 59 matched, 0 eligible (all voip).**
- Open Push to GHL → Confirm shows **"0 of 59 eligible"** and the **Push button
  is disabled**. Confirm you **cannot** enqueue. (Do not push.)

---

# SEQUENCE B — Standard fields, tags, created/updated, dedupe

**All of Sequence B uses ONE all-eligible slice so the re-push chain works.**
**Link:** https://inventory.scaletopia.io/people?phoneType=mobile&country=GB
**Expected: 14 matched, all 14 eligible.**

### G-3 — First push: defaults + company fallback + tag + Created count
- Standard fields: **defaults** (Company name = brand-preferred; these link to
  brand-null companies → **raw-name fallback** expected).
- Custom fields: optionally map one to a populated column.
- **Tag: `ghl-test-a`.** **Push (14).**
- Verify Push Activity: **Total 14, Created 14, Updated 0, Failed 0.**
- Verify in GHL: 14 contacts; **companyName = the raw `company_name`** (fallback,
  not blank); tag `ghl-test-a` on every one.

### G-4 — Re-push same people: Updated + dedupe-sync + tag append (highest risk)
Guards the 400-dedupe path: PUT existing contact (fields), append tag, count as
Updated — no duplicate, no tag replacement.
- Same link, same client. **City → Static value → `SECOND-CITY`** (so you can see
  the update land). **Tag: `ghl-test-b`.** **Push (14).**
- Verify Push Activity: **Created 0, Updated 14, Failed 0.**
- Verify in GHL: **no duplicate contacts** (same 14 ids); **City = `SECOND-CITY`**
  (the dedupe PUT applied); **both** `ghl-test-a` **and** `ghl-test-b` present
  (tags append, not replace).

### G-5 — Static value on a standard field (+ the `""` edge)
- Same link. **City → Static value → `QA-CITY`.** **Push (14).** Verify City =
  `QA-CITY` on all.
- **G-5b (the D2 edge):** re-push with **City → Static value left BLANK.** Per
  the code this sends `city: ""` and **blanks City** in GHL. Verify City becomes
  **empty** on the contacts and record it — this is the documented divergence
  from custom fields (which drop a blank).

### G-6 — Ignore a standard field leaves the existing GHL value untouched
- Same link. **Country → — ignore —.** **Push (14).**
- Verify in GHL: each contact's **existing `country` is unchanged** (not blanked,
  not the string `"null"`).

---

# SEQUENCE C — Custom fields (needs the Testing location's custom fields)

Use the same slice (`phoneType=mobile&country=GB`, 14). These require custom
fields defined on the Testing GHL location (Settings → Custom Fields).

### G-7 — Column source, drop-if-empty
- Map a custom field → a column populated on **some** of the 14 and null on
  others. **Push.**
- Verify in GHL: contacts with a source value → field populated with that exact
  value; contacts with null/empty source → the field is **absent** (not
  present-with-empty-string).

### G-8 — List / number stringification
- Map a custom field → a **list** column (e.g. keywords / technologies / tags),
  and another → a **numeric** column (employees / founded year). **Push.**
- Verify in GHL: the list arrives as **`a, b, c`** (comma-**space** join, **not**
  JSON `["a","b"]` — deliberately different from EmailBison); the number arrives
  as its string form. (Note: the code sends everything as a string regardless of
  the GHL field's declared type — if you bind to a numeric/date-typed GHL field,
  watch for a 422.)

### G-9 — Static custom-field value (+ blank edge = dropped)
- Custom field → **Static value → `qa-literal-test`.** **Push.** Verify every
  contact has that field = the exact literal.
- **G-9b:** custom field → Static value **blank** → the field should be
  **dropped** (contrast G-5b, where a blank standard static sends `""`).

### G-10 — Empty / stale custom-field list
- If the Testing location has **zero** custom fields: the mapping step shows
  only the 7 standard rows, **no error**. — or —
- Create a new custom field in GHL, then open the mapping step **without
  reloading** → the new field should be **absent** (fetch is cached per client);
  reload to see it. Record which you observed.

---

# SEQUENCE D — Tags & mapping persistence

Same slice (14).

### G-11 — Tag edge cases
- **Blank tag** → contacts pushed with **no tag** added.
- **Whitespace-only tag** (e.g. `"   "`) → trimmed to nothing → **no tag**
  (not a literal-space tag).

### G-12 — Mapping remembered per client
- Push once with a **non-default** mapping (e.g. City → Static, one custom field
  mapped). Reopen the Push-to-GHL dialog for the **same client** → your prior
  choices should be **pre-selected** (not reset to defaults/Skip).

---

# SEQUENCE E — Multi-client / bad creds (OPTIONAL — needs a 2nd GHL client)

### G-13 — Same person to two different locations
- Push the 14-person slice to Client A, then the same slice to **Client B** (a
  second client with a *different* GHL location). Verify: contacts appear in
  **both** locations; **both** pushes count as **Created** (created/updated
  tracks `platform_pushes` per client, not GHL); the person's `pushed_to_ghl`
  flag is just `true` (it's per-person, not per-client).

### G-14 — Bad credentials → all-failed with a clear reason
- Point a client at an **invalid/expired GHL API key** (valid location id). Push
  a small eligible slice → **all failed**, each with a 401-style reason in Push
  Activity (not a silent success). Restore creds after.

---

## Coverage map

| # | Guards | Failure symptom |
|---|--------|-----------------|
| G-1 | eligibility split (confirm dialog) | landline/null pushed; count mismatch |
| G-2 | zero-eligible disable | push enabled / job enqueued for 0 |
| G-3 | defaults + company fallback + tag + created | blank company; miscount; tag missing |
| G-4 | 400-dedupe: PUT + append + Updated | fail / duplicate / tag replaced / field not synced |
| G-5 | static standard field + `""` edge | marker leak; unexpected blank behavior undocumented |
| G-6 | ignore standard field | ignored field sent as null/blank |
| G-7 | custom column drop-if-empty | empty string sent instead of omitted |
| G-8 | list/number stringify | JSON array / no-space join / 422 on typed field |
| G-9 | static custom field + blank drop | per-contact source used; blank not dropped |
| G-10 | empty/stale custom list | mapping errors; stale-cache surprises |
| G-11 | tag trim/empty | literal-space tag / crash |
| G-12 | per-client mapping persistence | mapping doesn't reload |
| G-13 | multi-location + per-person flag | wrong location; cross-client custom-field bleed |
| G-14 | bad-cred failure | silent success / opaque error |

## Needs different setup / not UI-testable
- **>100 custom fields** on a location (G-10/pagination) — **suspected defect**:
  the fetch has no page loop, so fields past page 1 are likely never mappable.
- Retry/backoff on 429/5xx — needs GHL to actually throttle/5xx.
- Worker resumability on multi-tick (thousands-of-eligible) batches — only
  indirectly observable via Push Activity progress.
- Preview-vs-execution eligibility drift — timing-dependent race.
- Legacy saved-mapping upgrade — needs a pre-migration `push_field_mappings` row.
- Forcing exactly one record to fail inside a good batch — needs a value GHL
  rejects on one row only.

## Results log (fill as you go — the verification subagent reads this)

| Test | Expected (matched / eligible) | Observed Push N | Pass/Fail | Notes |
|------|------------------------------|-----------------|-----------|-------|
| G-1 | 18 / 4 | | | |
| G-2 | 59 / 0 (disabled) | | | |
| G-3 | 14 / 14 | | | |
| G-4 | 14 / 14 | | | |
| G-5 | 14 / 14 | | | |
| G-6 | 14 / 14 | | | |
| G-7 | 14 / 14 | | | |
| G-8 | 14 / 14 | | | |
| G-9 | 14 / 14 | | | |
| G-10 | — | | | |
| G-11 | 14 / 14 | | | |
| G-12 | 14 / 14 | | | |
