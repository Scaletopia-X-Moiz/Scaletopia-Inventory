# GHL push — "Internal" test client verification

Two-session verification of the People → GHL push feature (`components/people/push-to-ghl-button.tsx`
→ `app/api/people/push-to-ghl/route.ts` → `lib/ghl/push-to-ghl.ts` → `lib/ghl/client.ts`), using a
dedicated throwaway GHL sub-account added as a client for this purpose. 2026-08-03.

## Client under test

- GHL sub-account "Internal (DO NOT SETUP)", location id `MeFEd7scikKpI44Utr8N` — one of 35
  sub-accounts under the agency, intentionally unused in production so it's safe to push
  synthetic/test contacts into.
- Added to the app's `clients` table as slug `internal`, name `Internal`, with a
  location-scoped GHL PIT in `ghl_api_key` and `ghl_location_id` set. No EmailBison
  credentials — EmailBison push was out of scope for this client.

## Session 1 — API-level verification (no browser access)

The Chrome extension wasn't connected yet, so the underlying push logic was exercised directly
against the live GHL API with a throwaway `tsx` script (reimplementing the request shapes from
`lib/ghl/client.ts` / `lib/ghl/contact-payload.ts` / `lib/ghl/tag.ts`, since those files (and
`lib/data/clients.ts`, `lib/supabase/admin.ts`) start with `import "server-only"`, which throws
outside the Next.js server runtime). Verified, then deleted the test contact afterward:

- Custom-fields fetch: 200, empty array (location has none defined — not a bug).
- Contact creation: 201.
- Duplicate-contact detection on a repeat push with the same phone: 400 with `meta.contactId`.
- Tag-append-on-duplicate path: 201, both tags present on a follow-up `GET`.
- Full round-trip via `GET /contacts/{id}`.

This confirmed the push logic itself works, but not the UI path a real user drives (client
picker, eligibility gate, field-mapping step, SSE progress, Push History).

## Session 2 — full UI-level verification (this session)

Chrome extension connected; drove the actual `/people` page as the `claude-qa-test` account.

**Test data**: reused the two pre-existing QA fixture people (`claude-qa-test-1@scaletopia.local`,
`claude-qa-test-2@scaletopia.local`, company "Scaletopia QA Sandbox"). Neither had a mobile/verified
phone by default, so first ran the eligibility check with both ineligible (see below), then
temporarily set `phone_type='mobile', phone_status='verified'` on `claude-qa-test-1` via a
throwaway Supabase script to exercise the actual push path, and reverted both fields (plus
`pushed_to_ghl`) back to `null`/`false` immediately after.

### What was exercised and confirmed

1. **Client picker** (`Push to GHL` button on `/people`, filtered to the 2 QA rows) — "Internal"
   appears correctly in the "choose a client" list alongside the other 14 clients.
2. **Eligibility gate** — confirm dialog reported "0 of 2 people are eligible (mobile or
   toll-free phone) ... 2 will be skipped (landline or unverified phone)" before the phone-field
   change, then "1 of 2 people are eligible ... 1 will be skipped" after. Matches
   `ELIGIBLE_PHONE_TYPES = new Set(["mobile", "toll_free"])` in `lib/ghl/push-to-ghl.ts` exactly.
   The "Push 0" button was disabled when nothing was eligible — confirms the UI can't be used to
   force a push of ineligible rows.
3. **Custom-fields mapping step** — did not appear, because the Internal location has zero custom
   fields. This was an open question from session 1 (does the empty state render gracefully or
   error?) — confirmed it renders gracefully: the flow just skips straight to the eligibility
   confirm dialog.
4. **Push + SSE result** — "Push complete — Created: 1, Tag appended (already in GHL): 0,
   Failed: 0, Skipped (landline/other): 1."
5. **Push History page** (`/push-history`) — logged the push correctly (person, client "Internal",
   platform "GHL", campaign string, GHL contact id, pushed-by `claude-qa-test@scaletopia.local`,
   "Just now"). Unlike session 1's manual DB write, this went through the real
   `app/clients/actions.ts` / push route, so activity logging worked as designed — no gap this
   time.
6. **Live GHL cross-check** — fetched the resulting contact directly from the GHL API
   (`GET /contacts/{id}`) and confirmed correct `firstName`/`lastName` ("ClaudeQA"/"TestOne"),
   email, phone, `companyName` ("Scaletopia QA Sandbox"), and the expected tag
   (`internal - unknown | unknown | united states | manual-csv`).

### Cleanup performed

- Reverted `claude-qa-test-1`'s `phone_type`, `phone_status` back to `null` and `pushed_to_ghl`
  back to `false` (confirmed against the untouched `claude-qa-test-2` row as the baseline).
- Deleted the test contact from the live GHL Internal sub-account (`DELETE /contacts/{id}` →
  `{"succeeded":true}`).
- Left the Push History row in place — it's an audit log of a real push that happened, not test
  residue.
- Removed all throwaway `.scratch/*.mjs` scripts used for the DB reads/writes and GHL API calls.

## Finding: stray duplicate client row (unrelated bug, now fixed)

While in `/clients`, found a second row also named "Internal (DO NOT SETUP)" — slug
`pit_5b58dad6_1a73_436a_ae52_1f3b3dc906e3`, `ghl_location_id` **null**, `is_active: true`. Visible
in both the `/clients` table and the "Push to GHL" client picker dropdown alongside the correctly
configured `Internal` row. Root cause not confirmed, but the slug shape (`pit_<uuid>`) suggests it
was auto-generated from a pasted PIT key during an earlier, incomplete client-creation attempt in
session 1, before the properly-named `Internal` row was created via direct script.

Risk: the app's `clients` UI has no delete action (`app/clients/actions.ts` only supports
create/update), so this row could only have been removed with a direct DB delete. If a user had
picked it in the push picker, the push would very likely have failed given the null location id.

**Fixed**: row deleted from the `clients` table (confirmed via the app's own `/clients` page and
`/people` push picker — both now show a single "Internal" client).

## Session 3 — custom-fields mapping step, and a critical bug it uncovered

To close the one gap left by session 2, created a real custom field on the Internal GHL location
(`QA Lead Score`, id `4rr8UHTIOki9jPTT9bTm`) via a throwaway script, and seeded
`custom_data.qa_lead_score = "87"` on `claude-qa-test-1` so an active enrichment column would have
real data to map.

### Bug found: GHL push always 422s when a field mapping is active

Driving the full UI flow (add `qa_lead_score` enrichment column on `/people` → Push to GHL →
Internal → mapping step maps `qa_lead_score` → `QA Lead Score` → confirm → push) failed with
**Created: 0, Failed: 1** on the first attempt.

Root cause, confirmed by replaying the exact wire payload directly against GHL's API: GHL's
`POST /contacts/` endpoint requires the custom-field array on a property named **`customFields`**
(plural). The app sent **`customField`** (singular) everywhere — `GhlContactPayload` in
`lib/ghl/client.ts`, `GhlContactPayloadShape` in `lib/ghl/types.ts`, and the payload construction
in `lib/ghl/push-to-ghl.ts` — so GHL rejected every push with an active mapping with
`422 "property customField should not exist"`. This has been broken since ticket #51 shipped the
mapping feature; the unit tests never caught it because they mock `fetch` and assert whatever key
the code happens to send, rather than against GHL's real schema.

**Fixed**: renamed the field to `customFields` (plural) throughout `lib/ghl/client.ts`,
`lib/ghl/types.ts`, `lib/ghl/contact-payload.ts`, and `lib/ghl/push-to-ghl.ts`, with matching test
updates in `contact-payload.test.ts` and `push-to-ghl.test.ts`. All 28 `lib/ghl` unit tests pass.

### Re-verified end-to-end after the fix

Re-ran the same UI flow after the fix: **Created: 1, Failed: 0**. Confirmed directly against the
live GHL API that the new contact (id `PyX7jq4obsS6nKAwJo4G`, created fresh — the prior contact
this phone number would have deduped against was deleted first specifically to force a real
create, not a tag-append) carries `customFields: [{"id": "4rr8UHTIOki9jPTT9bTm", "value": "87"}]`
exactly as mapped.

Also incidentally re-confirmed: the mapping step's "Skip" default, the dropdown listing the
correct GHL field by name, and the post-push "remove temporary columns?" prompt all worked as
designed.

### Cleanup performed

- Deleted the GHL test contacts created during this session (both the intermediate one and the
  final verified one) and the `QA Lead Score` custom field from the Internal location.
- Reverted `claude-qa-test-1`'s `phone_type`, `phone_status`, `pushed_to_ghl`,
  `pushed_to_ghl_at`, and `custom_data` back to baseline (confirmed via direct query).
- Removed the active `qa_lead_score` enrichment column from the `/people` view via the app's own
  "remove temporary columns?" prompt.
- Removed all throwaway `.scratch/ghl-mapping-*.mjs` scripts.
- Left both Push History rows from this session in place, consistent with session 2's precedent —
  they're an audit log of real pushes, not test residue.

## Session 4 — production re-verification of the `customFields` fix, plus edge-case probing

Re-verification session, run entirely against **live production** (`https://inventory.scaletopia.io/`,
not the dev server), after commit `1dc0db2` (the `customField` → `customFields` rename from session 3)
was pushed to `main` and Vercel finished deploying it (confirmed via a fresh `X-Vercel-Id` header).
Goal: treat the session-3 fix with skepticism and actively try to break it, not just re-run the happy
path.

**Test data**: the two reusable QA fixture people (`claude-qa-test-1@scaletopia.local`,
`claude-qa-test-2@scaletopia.local`), confirmed at baseline first (`phone_type`/`phone_status` null,
`custom_data: {}`, `pushed_to_ghl: false`) via a throwaway Supabase script. Created two throwaway GHL
custom fields on the Internal location for this session: `QA Lead Score S4` and `QA Priority Tier S4`.

### What was exercised

1. **Mixed-batch mapping (missing value on one person)** — set `claude-qa-test-1` to `phone_type:
   mobile`, `phone_status: verified`, `custom_data.qa_lead_score: "92"`; set `claude-qa-test-2` to
   `phone_type: toll_free`, `phone_status: verified`, with **no** `qa_lead_score` in `custom_data`
   (empty object). Added the `qa_lead_score` enrichment column on `/people`, mapped it to `QA Lead
   Score S4` in the Push-to-GHL mapping step, and pushed both. Result: **Created: 2, Failed: 0**.
   Confirmed directly against the live GHL API: person 1's contact carries
   `customFields: [{"id":"Il27BfPloqPfK5ldryo3","value":"92"}]`; person 2's contact carries
   `customFields: []` — the missing value was correctly omitted rather than sent as `null`/`""` or
   causing a failure.
2. **Mapping step's "Skip" default** — reopened the mapping dialog twice (once per push in this
   session) and confirmed it always defaults back to "Skip" for every enrichment column, never
   remembering a previous mapping choice.
3. **Repeat push / tag-append-dedupe path with an active mapping** — pushed the same two people again
   (mapping still active, mapped to the same field) immediately after the first push. Result:
   **Created: 0, Tag appended (already in GHL): 2, Failed: 0**. Re-fetched both contacts from GHL
   afterward and confirmed they were untouched (same contact IDs, same `customFields` values, no
   duplicate contacts created) — the fix doesn't regress the duplicate-detection/tag-append path, and
   GHL's dedupe-triggered `400` doesn't get misread as a `customFields`-shape failure.
4. **Multiple simultaneous field mappings** — added a second custom_data field (`qa_priority_tier`:
   `"gold"` on person 1, `"silver"` on person 2) and a second GHL custom field (`QA Priority Tier
   S4`), deleted the two prior test contacts to force fresh creates, added both enrichment columns on
   `/people`, and mapped both (`qa_lead_score` → `QA Lead Score S4`, `qa_priority_tier` → `QA Priority
   Tier S4`) in the same push. Result: **Created: 2, Failed: 0**. Confirmed against GHL: person 1's
   contact carries both `customFields` entries (`gold` and `92`); person 2's contact carries only the
   `qa_priority_tier` entry (`silver`) — the missing `qa_lead_score` was again correctly omitted, not
   sent as garbage.
5. **Client picker / stray-duplicate regression check** — reconfirmed only a single "Internal" row
   appears in both the `/clients` table and the Push-to-GHL client picker (the session-2 duplicate-row
   bug stayed fixed).

### Non-bug finding: mapping dropdown only shows custom fields present at page load

When the second GHL custom field (`QA Priority Tier S4`) was created via the API *after* `/people` had
already loaded, the mapping dropdown only listed the first field (`QA Lead Score S4`) — the second
field wasn't available to map until the page was reloaded. This is expected behavior for a
fetch-once-per-page-load list, not a bug: a real user creates the GHL custom field ahead of time (in
GHL directly), so the field would already exist before they ever load `/people`. Noting it here in
case it's ever worth an "invalidate/refetch on mapping-dialog-open" improvement, but not filing it as a
defect.

### Result: original bug confirmed fixed

No `422`s, no `customField`/`customFields` shape errors, across all four scenarios above (plain mapped
push, missing-value mixed batch, repeat/tag-append push, and dual-field mapping). The session-3 fix is
holding up on live production under adversarial-ish conditions, not just the original happy path.

### Cleanup performed

- Deleted all 4 GHL test contacts created this session (`dnFBay5RGQAkQUrK5pCl`, `pxRcN8Bm9114D2GxN72e`,
  `5ZQEXdaFSPhJa0Qp854g`, `tZjeiZiCnWySUEjKDD9a`) — verified via `GET /contacts/{id}`, which for a
  deleted contact returns HTTP `400` with `{"message":"Contact not found for id:...", "error":"Bad
  Request"}` (GHL's actual behavior for this endpoint; it doesn't return `404`, consistent with the
  `400 + meta.contactId` behavior noted for duplicate-detection in session 1).
- Deleted both throwaway GHL custom fields (`QA Lead Score S4`, `QA Priority Tier S4`) from the
  Internal location.
- Reverted both QA fixture people's `phone_type`, `phone_status`, `custom_data`, `pushed_to_ghl`, and
  `pushed_to_ghl_at` back to baseline (`null`/`{}`/`false`/`null`), confirmed via a direct re-query
  matching the pre-session snapshot exactly.
- Removed both temporary enrichment columns (`qa_lead_score`, `qa_priority_tier`) from the `/people`
  view via the app's own "remove temporary columns?" prompt.
- Deleted all throwaway `.scratch/ghl-*.mjs` scripts created this session.
- Left all Push History rows from this session in place, consistent with sessions 2 and 3's
  precedent.

## Session 5 — heavy multi-type enrichment, unicode/long-value stress test, and push-history cross-verification

Follow-up UI verification session, run against the dev server (`localhost:3000`), aimed at closing
the gaps sessions 1–4 left open: correctness of pushed data field-by-field (not just "push
succeeded"), data-loss checks on a heavily-enriched subject, and a first real look at
`/push-history`. Added a third reusable QA fixture person (`claude-qa-test-3@scaletopia.local`,
company "Scaletopia QA Sandbox") to support 3-person batch-push testing; decision (confirmed with
the user): keep it permanently alongside `claude-qa-test-1`/`-2` rather than deleting it after the
session.

**Test data**: all 3 QA fixture people set to `phone_type: mobile`, `phone_status: verified`
(GHL-eligible), each with heavy multi-type `custom_data` exercising all 5 enrichment column types
(text, number, boolean, list, date) plus deliberate edge cases on person 1 (unicode/emoji text, a
500+ character long value, and empty-string/`null`/empty-list values that should be omitted from
the GHL push) and a deliberately-missing key on person 2 (`qa_long_field` absent entirely, not just
empty). Created 8 matching GHL custom fields on the Internal location for this session.

### What was exercised

1. **Full-mapping push of a 3-person batch with heavy enrichment** — mapped all 8 enrichment
   columns to their GHL custom fields, confirmed eligibility showed 3/3, and pushed. Result:
   **Created: 3, Failed: 0**, one new GHL contact per person (`claude-qa-test-1` →
   `FDWruKYujwnxyK0OOCTY`, `-2` → `rZwfmolKh6T7U6K42853`, `-3` → `11GqjyvDeKj1cjDWFkuG`).
2. **Field-by-field GHL cross-verification** — fetched all 3 contacts directly via
   `GET /contacts/{id}` and diffed every field against the seeded data: firstName, lastName, email,
   phone, companyName, city, country, tag (the user-typed tag, applied as-is — `buildGhlTag` was
   removed, see commit `a43bcb5`), and every `customFields`
   entry. All correct, including: list values joined with `", "`; boolean/number values stringified
   correctly; unicode/emoji text (`qa_notes` on person 1) round-tripped byte-for-byte; the 500+ char
   long value came through intact; and `qa_empty_field`, `qa_null_field`, `qa_empty_list`, and the
   missing-key `qa_long_field` on person 2 were all correctly **absent** from the `customFields`
   array rather than present with a blank value. No bugs found.
3. **Partial-mapping re-push (data-loss check)** — re-pushed with only a subset of the 8 columns
   mapped. Confirmed the previously-pushed full set of `customFields` on the existing GHL contacts
   was left untouched (no data loss, no overwrite-with-blank) — cross-checked against `lib/ghl/client.ts`,
   which confirmed by reading the code that the dedupe/tag-append path never sends a `customFields`
   update at all, mapped or not. This matches the intentional "unmapped columns are simply not
   included" design already documented in session 3/4, now confirmed to also apply cleanly on the
   repeat-push path.
4. **Repeat full-mapping push (3rd total push) / dedupe-preservation** — pushed the same 3 people
   again with the full 8-field mapping active. Result: **Created: 0, Tag appended: 3, Failed: 0**;
   tags were not duplicated and `customFields` on all 3 contacts remained exactly as set by the
   first push — consistent with session 4's dedupe-path precedent, now confirmed under heavy
   multi-type enrichment rather than a single field.
5. **`/push-history` cross-verification** — confirmed the `platform_pushes` table (upsert on
   `(person_id, client_id, platform)`) held exactly 3 rows for these people/Internal/GHL, and that
   every row's GHL contact id and `pushed_by` (`claude-qa-test@scaletopia.local`) matched the live
   GHL contacts exactly. Design note, not a bug: this table is a "latest state" log (one row per
   person/client/platform, upserted), not an attempt-by-attempt audit trail — worth a ticket if
   audit completeness (e.g. distinguishing a create from a later tag-append) is ever required; not
   filed this session.
6. **Client-picker regression check** — the Session 2 stray-duplicate-client-row bug stayed fixed
   (only one "Internal" row) across 3 separate client-picker opens this session. A much larger
   "dozens of stray `__test-emailbison-push_client-N` rows before the real list" observation from
   earlier in the session did not reproduce on any of those 3 opens — treated as unconfirmed/not
   reproducible; not filed as a ticket, noted here only for the record.

### Non-bug findings, noted but not filed as tickets

- **UX papercut**: after closing a push-result dialog, the "remove temporary columns?" prompt
  appears immediately and can steal a click meant for re-clicking "Push to GHL" (e.g. to push
  again right after reviewing a result). Low-priority; worth a ticket if it comes up again, not
  filed this session.
- **`/push-history` is a latest-state log, not an audit trail** (see item 5 above) — same
  disposition, worth a ticket only if audit completeness becomes a real requirement.

### Result

No bugs found this session — the `customFields`-shape fix from session 3 continues to hold under
heavy multi-type, unicode, long-value, and missing-key conditions, across create, partial-mapping,
and dedupe/tag-append paths, with `/push-history` matching live GHL state exactly.

### Cleanup performed

- Deleted the 3 GHL test contacts created this session (`FDWruKYujwnxyK0OOCTY`,
  `rZwfmolKh6T7U6K42853`, `11GqjyvDeKj1cjDWFkuG`) via `DELETE /contacts/{id}` — verified via a
  follow-up `GET /contacts/{id}` on each, which returned `400 Contact not found`, matching the
  established GHL delete-verification behavior from session 4.
- Deleted all 8 GHL custom fields created this session from the Internal location via
  `DELETE /locations/{locationId}/customFields/{id}` — verified via a follow-up
  `GET /locations/{locationId}/customFields` showing none remaining.
- Reverted `claude-qa-test-1` and `claude-qa-test-2` to baseline (`phone_type`, `phone_status`,
  `custom_data`, `pushed_to_ghl`, `pushed_to_ghl_at` all back to `null`/`{}`/`false`/`null`).
- Per the user's decision to keep `claude-qa-test-3` as a permanent 3rd fixture, reverted it to the
  same bare-identity shape as `-1`/`-2` (including clearing the seeded `city: "Los Angeles"` value)
  rather than deleting the row.
- Removed all 8 enrichment columns from the `/people` view via the app's own "×" on each column
  chip (not just a URL change) — confirmed the empty state survives a full page reload.
- Deleted all throwaway `.scratch/ghl-session5-*.mjs` scripts used for seeding, field creation, and
  the cleanup itself.

## Outstanding (not covered by any session)

- No route-level automated test exists for `app/api/people/push-to-ghl/route.ts` or
  `app/api/clients/[id]/ghl-custom-fields/route.ts` — only `lib/ghl/push-to-ghl.ts`'s unit tests
  (`lib/ghl/push-to-ghl.test.ts`) cover the underlying logic.
- The unit tests still validate against a mocked `fetch` rather than GHL's real API contract, so a
  wire-shape regression like the `customField`/`customFields` bug above could recur undetected by
  `npm test` alone — worth considering a contract/shape check against GHL's actual schema if this
  class of bug matters enough to guard in CI.
