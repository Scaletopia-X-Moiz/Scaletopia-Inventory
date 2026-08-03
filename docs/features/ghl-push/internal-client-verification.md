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

## Outstanding (not covered by any session)

- No route-level automated test exists for `app/api/people/push-to-ghl/route.ts` or
  `app/api/clients/[id]/ghl-custom-fields/route.ts` — only `lib/ghl/push-to-ghl.ts`'s unit tests
  (`lib/ghl/push-to-ghl.test.ts`) cover the underlying logic.
- The unit tests still validate against a mocked `fetch` rather than GHL's real API contract, so a
  wire-shape regression like the `customField`/`customFields` bug above could recur undetected by
  `npm test` alone — worth considering a contract/shape check against GHL's actual schema if this
  class of bug matters enough to guard in CI.
