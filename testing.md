# Testing log — Scaletopia Inventory

Manual QA pass driven via Claude in Chrome against local dev (`localhost:3000`).

**Scope for this pass:** everything EXCEPT actual pushes to GHL or EmailBison.
Those two are held back until a sandboxed GHL sub-account / EmailBison
workspace is confirmed (see prior conversation). No "Push to GHL", "Add to
EmailBison", or "Add to Campaign" button is clicked for real in this pass —
at most the GHL preview (dry-run) endpoint, which makes zero GHL calls.

Status key: ✅ works · ⚠️ works but rough edge · ❌ broken · ⏭️ skipped (out of scope)

---

## Summary so far

**Solid:** login/auth, dashboard stats, Companies + People list/filter/facet/virtual-column system, push-confirm dialogs (won't fire without an explicit client pick), push history page, team management + self-removal guard, activity audit log, ticket tracker, import wizard UI.

**Found:**
1. Niche tagging data quality — at least one company (`Heavenly Heating`, construction/HVAC) is tagged `niche: dtc-beauty`. Filter itself is correct; the underlying enrichment data isn't. Worth a broader spot-check before trusting niche-filtered push lists.
2. `/clients` page has no "Add client" UI — by design, confirmed in code (only `updateClientField` exists, no create action). Adding the sandbox GHL test client must be a direct Supabase insert.
3. EmailBison credentials (`emailbison_api_key`, `emailbison_workspace_id`) have **no UI anywhere** — only settable via direct Supabase edit, unlike GHL which has a full self-serve page. If that's unintentional, worth a ticket.

**New bugs found this pass (session 2 — non-push QA):**
4. **Country labels broken for every country except US/UK/Canada** — `lib/data/country.ts`'s `COUNTRY_ALIASES` only has entries for `us`/`usa`/`united states`, `gb`/`uk`/`united kingdom`, `ca`/`canada`. Every other country falls through `countryLabel()`/`normalizeCountry()`'s fallback, which just title-cases the raw 2-letter ISO code instead of expanding it — so India renders as "In", Australia as "Au", Germany as "De", Netherlands as "Nl", etc. Confirmed in two places: the dashboard's Geography widget and the Companies/People "Country" filter dropdown (both app-wide, not a one-off). US/UK/Canada happen to look right because their codes coincide with real word fragments. Filtering itself works correctly (`?country=IN` returns real India-based companies) — this is purely a display/label bug. Worth a real ticket; likely a quick fix (expand `COUNTRY_ALIASES` or swap the fallback for a proper ISO-3166 name table).
5. **Manual CSV import doesn't derive `full_name` from First/Last Name** — `lib/import/normalize.ts` maps "First Name"/"Last Name" headers to separate `first_name`/`last_name` keys but never combines them into `full_name`; `lib/import/push.ts` has no derivation step either. Imported a 2-row synthetic test CSV (First Name + Last Name columns, no "Full Name" column) via Import → People → Manual CSV — wizard reported "2 Inserted, 0 Failed" and the rows are real (found by exact email search, Company field landed correctly), but the People list's **Full Name column shows blank ("—")** for both rows, and the **name search box doesn't find them** by first or last name (only an exact email match worked). Anyone importing via a First/Last-Name-only source (common for manual CSV) will get blank-looking, unsearchable-by-name rows. Test rows left in DB tagged `client=claude-qa-test`, `niche=qa-synthetic-test-data` for easy identification/cleanup — not deleted since that's a real Supabase write, left for you to confirm.
6. **Companies CSV export drops one row vs. the on-screen count** — filtered Companies list to `country=IN` (2,457 companies per the UI, confirmed stable across repeated loads), clicked Export CSV, downloaded and counted rows: **2,456 data rows**, one short. Reproduced twice. Smells like an off-by-one in the export endpoint's pagination/keyset boundary (this repo's `docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md` describes DB-side keyset pagination for the main list — the export path may share that logic with a boundary bug) rather than live data drift, since the count didn't change between the list view and the export.
7. **React hydration error on `/activity`** — DevTools overlay shows a "Recoverable Error" on page load: `app/activity/activity-view.tsx:164`, the "When" column's `title` tooltip attribute renders a different date-time format on server vs. client (server: `"2 Aug 2026, 15:43"`, client: `"Aug 2, 2026, 3:43 PM"`) — a locale-dependent `Date` formatting call that isn't deterministic between SSR and hydration. React recovers by re-rendering the subtree, so it's not user-visible, but it's a real console error worth fixing (likely `toLocaleString()`/`toLocaleDateString()` without a fixed locale, or a difference in server vs. browser default locale).

**Minor/rough edges found this pass:**
- Companies/People pages have a **sticky "default view"** — even a bare `/companies` URL with no query string gets silently rewritten to re-attach a previously-added virtual column (`case_study_1`, added in an earlier session and apparently persisted as a default). Not a bug, but worth knowing it's not a fresh URL == fresh view; someone could be confused why an "empty" URL shows extra columns. Cleared it via the column's "×" for the rest of this pass.
- Dashboard's **Catalog Distribution chart (By Niche/By Source line chart) has a hover tooltip but isn't clickable** — no navigation on click, unlike the adjacent Sources list (clickable → filters Companies) and the Top Industries bar chart (clickable → filters Companies) which both work. Inconsistent interaction model across dashboard widgets that look equally clickable.
- Custom date-range picker's end-date `<input type="date">` briefly produced a garbled value (`mm/02/12026`) when typed into after a preset click without repositioning focus first — native date-input segment quirk, not confirmed as an app bug, but the picker doesn't visually indicate which segment (month/day/year) has focus, which makes it easy to mistype. Low priority.

**Confirmed working this pass:** Cmd+K search (companies, niches — both search-and-navigate correctly), dashboard date-range presets (Today/Last 7 days/Last 30 days/All time all update stats+chart+sources correctly), Sources list drill-down, Top Industries bar drill-down, Country filter drill-down, Activity log content (renders full history, ~80 rows, no pagination UI needed at this volume but see note below), Import wizard full flow (Upload → Columns → Tags → Review → live SSE progress → Done, Manual CSV → People, with preflight dedupe counts matching actuals).

**Not yet tested (needs the sandbox GHL/EmailBison accounts, or more time):**
- An actual GHL push end-to-end (create + tag-append + dedupe-on-rerun + landline-skip eligibility).
- EmailBison "Add to EmailBison" + "Add to Campaign" (including the ~5min async campaign-attach behavior).
- Push-to-Clay (also a live external webhook — same caution as GHL/EmailBison, held back).
- Field-mapping panel behavior with intentionally malformed mappings.
- SSE progress stream resilience (closing the tab mid-push).
- Reverify email/phone bulk actions (these do call MillionVerifier/ClearoutPhone — live paid APIs — so same "ask first" caution applies before running them at scale).
- "This file also contains company data" checkbox on Import (didn't test the combined People+Companies extraction path).
- Activity log pagination *mechanism* specifically — there isn't one; the whole history renders at once (see finding below), so "does pagination work" is moot until the log is large enough to need it.

## Session log

### Setup
- Dev server: `npm run dev` (Next.js 16.2.9 / Turbopack), localhost:3000, `.env.local` (points at live Supabase — 109,756 companies / 14,187 people, real prod data).
- Test account: `claude-qa-test@scaletopia.local`, role `admin`, created directly via Supabase admin API + `profiles` row (script at `.scratch/create-test-user.mjs`, not committed). Safe to delete after testing via Team page or `supabase.auth.admin.deleteUser`.
- **Out of scope this pass**: any real "Push to GHL" / "Add to EmailBison" / "Add to Campaign" click. GHL preview/dry-run endpoint is fine (no GHL calls). Revisit once a sandboxed GHL sub-account + EmailBison workspace exist.

### ⚠️ Companies — data quality, not a code bug
Opened `Heavenly Heating` (dropcatch.com) — Industry: `construction`, description "construction company based out of Rr 1, Williams, Indiana", but `Niche: dtc-beauty`. Filtering Companies by Niche = dtc-beauty correctly returns exactly the rows tagged `dtc-beauty` in the DB (18,329 of them) — the *filter* works right, the underlying *data* is wrong for at least this row. Worth a spot-check of niche-tagging accuracy before anyone pushes a niche-filtered list expecting it to match reality (e.g. a "dtc-beauty" campaign list that's actually full of HVAC/construction companies). Not something I can fix from the UI — likely an enrichment/import issue upstream.

### ✅ Push History / Team / Tickets / Activity / Import — quick pass
- **Push History** (`/push-history`): client + platform filter dropdowns render (13 real clients + All, GHL/EmailBison/All platforms). Correctly shows "No pushes recorded yet." — matches dashboard's Pushes=0. Not exercised further since populating it for real means an actual push.
- **Team** (`/team`): lists real users + roles correctly (moizpriv47@gmail.com, saqlain@scaletopia.io, admin@scaletopia.test, my test account). My test account shows role dropdown but no "Remove" button on its own row — self-removal is correctly guarded in the UI, not just server-side (`app/team/actions.ts` also no-ops it server-side). Did not send a real invite (would email a real address).
- **Tickets** (`/tickets`): in-app tracker loads, shows existing tickets (#7 GHL Push, #8 EmailBison Push, both still "Open" despite those features clearly being built and working — maybe worth closing, your call, not a bug).
- **Activity** (`/activity`): full audit log, correctly recorded my own sign-in. Long history renders fine, no pagination tested yet (list was ~70 rows, didn't hit a "load more").
- **Import** (`/import`): multi-step wizard loads (Upload → Columns → Tags → Review), provider dropdown (AI Ark, Apollo, Blitz, Google Maps, Clay, Store Leads, LeadFox, BuiltWith, Clutch, Crunchbase, Yelp, Sales Navigator, Manual CSV, + custom), target table toggle (Companies/People), drag-drop zone. **Did not upload a file** — this is actually a good candidate for creating synthetic test People (own email/phone) via "Manual CSV" + a target-table upload, tagged with an obvious source, if we want realistic-looking test rows instead of raw SQL inserts for the eventual GHL/EmailBison push test.

### ℹ️ /clients page — confirms the plan, one gap found
- `/clients` lists all 13 real agency clients with editable GHL API key / GHL location ID fields (autosave onBlur) and an Active toggle. This is exactly the page to use to add the sandbox GHL client once you have credentials.
- **No "Add client" button exists anywhere in the UI.** Empty-state copy literally says "No clients yet. Add one directly in Supabase to get started." — confirmed in `app/clients/actions.ts`, which only exports `updateClientField` (no create action). So adding the sandbox test client *must* be a direct Supabase insert into the `clients` table, not something doable from the app UI — matches what we discussed, just confirming there's no UI shortcut.
- **Gap: EmailBison credentials (`emailbison_api_key`, `emailbison_workspace_id`) have no UI field at all** — not on this page, not anywhere else I found. They exist on the `clients` table and are read by `app/api/emailbison/push/route.ts`, but the only way to set them (for any client, not just a new test one) is a direct Supabase update. If EmailBison push testing/config is meant to be self-serve like GHL, this is a real product gap worth a ticket; for now it just means the EmailBison sandbox workspace's credentials also go in via direct SQL/table edit, not the Clients page.

### ✅ People page + push dialogs (UI-only, cancelled before commit)
- List loads (14,187 people), filters/facets present same as Companies (Niche/Source/Country/Employee size/Industry/Email status/Phone type/Has contact info), plus a Job-title free-text filter Companies doesn't have.
- Toolbar: Reverify emails, Reverify phone numbers, Push to Clay, **Push to GHL**, Add to EmailBison, Add to Campaign, Export CSV. Note: "Push to GHL" only appears on People, not Companies (Companies-table push routes through the People action per CONTEXT.md, so this checks out).
- Clicked "Push to GHL" → modal "Push to GHL — choose a client" lists real clients (Acceler8, Bigleap, Chamber Media, Chamber Media Secondary, Go Fish Digital, Growth Lab, Kynship, ...), radio buttons, none pre-selected, "Continue →" disabled until a client is picked. **Cancelled here** — did not select a client or continue, since that's a real GHL push and no sandbox client exists yet. Good safety property: impossible to fire a push without deliberately picking a target client first.
- TODO once sandbox client exists: redo this flow selecting the sandbox client, confirm the preview screen's eligible/skipped counts (`/api/people/push-to-ghl/preview`) before the final send.

### ✅ Login + Dashboard
- Sign-in with email/password works, redirects to `/`.
- Dashboard loads: Key Metrics (Companies 109,756 / People 14,187 / Niches 29 / Sources 8 / Pushes 0), niche/source distribution, top industries, geography breakdown, recent activity list. All populated correctly on first load.

---

## Session 2 — non-push QA continuation (2026-08-02)

Picked up from the handoff doc, still avoiding real GHL/EmailBison/Clay/verification-API calls. Logged back in as the same `claude-qa-test@scaletopia.local` account (session/cookie had persisted from before).

### ✅ Cmd+K search
Ctrl+K opens a command palette (default view: browse niches). Typed a company name (`Heavenly Heating`) → matched and navigated to the company record correctly. Typed niche names (`saas-crm`, `Food And Drink`) → matched and navigated to `Companies?niche=...` correctly, with the right row counts. Search-and-navigate works for both companies and niches.

Side discovery while doing this: the `saas-crm` niche also has non-software rows in it (`Peace River Heating`, `QDCA Services LLC` — both construction/HVAC), same class of problem as finding #1 (`Heavenly Heating` under `dtc-beauty`). `Food And Drink`, by contrast, looked clean (Koshervitamins, LIFE OF GENKI, TruLabs, etc. all genuinely food/beverage). So the niche mistagging isn't universal — but it isn't a one-off either. Worth a real audit pass per-niche before trusting niche-filtered push lists broadly, not just for `dtc-beauty`.

### ✅ Dashboard date-range picker
Presets (Today / Last 7 days / Last 30 days / All time) all work — URL updates to `?range=...`, Key Metrics/chart/Sources all recompute correctly (e.g. Last 30 days: 13,747 companies / 7,761 people vs. All time's 109,756 / 14,187; Today: correctly 0/0, no rows created today in this prod dataset). Custom range fields are native `<input type="date">` — see rough-edge note above about a garbled value when typing without repositioning focus; didn't chase further given it's a native-input quirk rather than clearly an app bug.

### ⚠️ Dashboard chart drill-downs — inconsistent
- Sources list (right sidebar): clicking a source navigates to `Companies?source=...` correctly (Builtwith → 52,978 companies, matches sidebar count).
- Top Industries bar chart: clicking a bar navigates to `Companies?industry=...` correctly.
- Geography list: clicking a country navigates to `Companies?country=...` correctly — but see finding #4, the *label* shown is broken for non-US/UK/CA countries.
- Catalog Distribution (By Niche / By Source line+dot chart): hover shows a tooltip, but clicking a point does **nothing** — no navigation, URL unchanged. Inconsistent with the three drill-downs above.

### ❌ CSV export — real bug found
Filtered Companies to `country=IN` (2,457 shown, confirmed stable on reload), clicked Export CSV. Downloaded file (`companies.csv`, ~905KB) has a correct-looking header row and content (company name/domain/phone/email etc. all consistent with an India filter — `+91` numbers, `.in` domains) but only **2,456 data rows** — one short of the on-screen count. Reproduced by re-exporting. See finding #6.

### ❌ Activity log — hydration error + no pagination
- Opened `/activity` with dev tools — a Next.js error overlay ("1 Issue" badge) reveals a **Recoverable Error: hydration mismatch** at `app/activity/activity-view.tsx:164`, caused by the "When" column's tooltip (`title` attribute) formatting the same timestamp differently on server vs. client. See finding #7. React auto-recovers so it's not visually broken, but it's a real error worth fixing.
- Scrolled the full activity log (~80 rows) to the bottom — there's no "Load more" button and no infinite-scroll trigger. The entire history renders in one shot. Fine at this volume; worth a proactive look before it grows much further given this project's known perf sensitivity around large unpaginated queries (see `perf-nav-dashboard-latency` from prior work).

### ❌ Import wizard — completed full flow, found a real bug
Built a 2-row synthetic CSV (`First Name, Last Name, Email, Phone, Job Title, Company, Country`) with obviously-fake data (`claude-qa-test-1@scaletopia.local` / `claude-qa-test-2@scaletopia.local`, both tagged Company="Scaletopia QA Sandbox"). Ran it through Import → Manual CSV → target table People:
- **Upload**: file dropped and parsed correctly, previewed 2 rows/7 columns.
- **Columns**: auto-mapped every column correctly (First Name→first_name, Last Name→last_name, Email→email, Phone→phone, Job Title→job_title, Company→company_name, Country→country) — didn't need to touch anything.
- **Tags**: set Client=`claude-qa-test`, Niche=`qa-synthetic-test-data` for easy identification/cleanup later. Date auto-filled to today.
- **Review**: preflight check against Supabase ran live, correctly reported "2 in file → 2 after dedupe → 2 to insert → 0 to update" before I confirmed.
- **Push**: live SSE progress stream stepped through Normalizing → Checking existing → Partitioning → Inserting → Done in real time, ended with "Import Complete — 2 Input / 2 Inserted / 0 Updated / 0 Failed".
- **Verification found a bug**: the imported rows are real (found via exact-email search: `email=claude-qa-test-1@scaletopia.local` returns 1 row, Company field correctly shows "Scaletopia QA Sandbox"), but the People list's **Full Name column is blank** for both rows, and searching by name (`ClaudeQA`) returns 0 results even with no other filters. See finding #5 — `first_name`/`last_name` aren't being combined into `full_name` anywhere in the import pipeline.
- Did not test the "This file also contains company data — import companies too" checkbox, or import a file for the Companies target table, or push past 2 rows.
- **Left in DB**: 2 synthetic People rows (tagged `client=claude-qa-test`, `niche=qa-synthetic-test-data`, findable via `people?q=claude-qa-test-1@scaletopia.local` or similar) — not deleted, since that's a real write against the prod Supabase instance and felt like something to flag rather than silently clean up mid-session.

