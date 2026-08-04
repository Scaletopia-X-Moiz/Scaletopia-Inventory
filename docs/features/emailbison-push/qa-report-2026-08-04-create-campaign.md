# EmailBison push — live-verify create-campaign flow, incl. resumeCampaign (2026-08-04)

Live verification of the "Create a campaign" feature (issue #102, closing out #94's deferred
`resumeCampaign` check) for the six tickets implemented on `main`: #96 (client.ts calls), #98
(sender-emails endpoint), #97 (orchestrator), #99 (create-campaigns endpoint), #101 (People wizard
UI), #100 (Companies wizard UI). Run against a local dev server (`npm run dev`, `localhost:3000`)
driven via Chrome browser automation, using the `Internal` test client's dedicated EmailBison
workspace (`send.scaletopia.io`), same credential setup as the prior
`docs/features/emailbison-push/qa-report-2026-08-03.md` pass.

## Result summary

| Area | Result |
| --- | --- |
| Wizard renders (name, sender-email checkboxes live from #98, schedule, sequence step, add/remove) | ✅ Pass — all elements present and correctly populated for the Internal workspace |
| Sender-email checkboxes live-fetched from #98 endpoint | ✅ Pass — returned the workspace's one real sender (`ian.johnson@prospectchambermedia.com`) |
| Draft path (default form values: name, sender checked, default "UTC" timezone, one sequence step) | ❌ **Fail** — schedule creation 422s live (issue #103); campaign left orphaned (created, sender attached, no schedule) |
| Draft path (worked around #103 by picking `America/New_York`) | ❌ **Fail** — sequence-steps creation 422s live (issue #104); campaign left further orphaned (schedule now present, no sequence) |
| Launch path (same as above, `America/New_York` timezone) | ❌ **Fail** — same #104 sequence-steps 422 before ever reaching `resumeCampaign`. The app's own orchestrator never calls `resumeCampaign` because it throws on the prior step. |
| `resumeCampaign` — first-ever live call | ⚠️ Verified via a **direct API call** against the orphaned test campaign (bypassing the broken UI/app route, see below), not through the app's own `/api/campaigns/{id}/resume` route, since #104 blocks the app from ever reaching that call. Response: `HTTP 400`, `{"data":{"success":false,"message":"This campaign is incomplete and cannot be launched. Campaigns should have a completed sequence and schedule, and should have leads and sender emails."}}` — see issue #105 for the shape discrepancy and its larger implication. |
| Cleanup | ✅ Pass — both test campaigns (draft-path orphan id 1004, launch-path orphan id 1005) deleted via EmailBison's `DELETE /api/campaigns/{id}` and confirmed gone (404 on GET-by-id, absent from `GET /api/campaigns` list). The stray `CLAUDE_API_TEST - delete me` campaign from a prior session was already gone before this pass started (confirmed via `GET /api/campaigns` — not present). |
| Console errors | None observed beyond the surfaced form error text (no unhandled JS exceptions) |

**Net result: the create-campaign wizard's happy path (default field values) is currently
non-functional end-to-end against a live EmailBison workspace.** Two independent bugs each
block it at a different step; issue #104 additionally prevents the app from ever reaching the
`resumeCampaign` call this ticket exists to verify.

## Bugs found (filed as GitHub issues)

| # | Issue | Severity | Summary |
| --- | --- | --- | --- |
| [#103](https://github.com/Scaletopia-X-Moiz/Scaletopia-Inventory/issues/103) | Default timezone "UTC" rejected live by EmailBison (422 "The selected timezone is invalid.") | High — hits the default value | `TIMEZONE_OPTIONS`'s first/default entry, `"UTC"`, is not accepted by EmailBison's schedule endpoint. Also tried `"Etc/UTC"` and `"GMT"` directly against the API — both also rejected. A real zone (`America/New_York`) works. Leaves an orphaned partial campaign (no rollback). |
| [#104](https://github.com/Scaletopia-X-Moiz/Scaletopia-Inventory/issues/104) | Step 1's hardcoded `wait_in_days=0` rejected live by EmailBison (422 "must be at least 1"), blocking the launch path from ever reaching `resumeCampaign` | Critical — no UI workaround exists | The wait-days input is only rendered for steps after the first (`{i > 0 ? ... : null}`), so Step 1 always submits `wait_in_days: 0`, which EmailBison unconditionally rejects for every step including the first. This is the more severe of the two: it blocks 100% of submissions that reach the sequence-steps call, regardless of any other input, and specifically prevents the app itself from ever calling `resumeCampaign`. |
| [#105](https://github.com/Scaletopia-X-Moiz/Scaletopia-Inventory/issues/105) | `resumeCampaign`'s live response for an incomplete/lead-less campaign is a `4xx`, not the assumed 2xx-with-`success:false` shape | Low (functionally harmless) / documentation-accuracy + a bigger design question | `assertOk` already throws correctly on any non-2xx before `assertSuccessBody` would even run, so this isn't a functional bug in the current code — but the doc comment's assumed shape doesn't match live reality. More importantly: the response message states a campaign needs leads attached before it can launch, and this flow never attaches leads at creation time — meaning **launching immediately after creation will always fail** until a separate "push leads to campaign" action runs first. Flagged for the team to confirm this two-step UX is intended. |

## Lower-confidence findings

None — the automation was consistent and reproducible across repeated attempts (the #103 and
#104 failures reproduced identically on every submission with their respective trigger
conditions).

## Other observations

- **Sender-email checkbox is effectively mandatory**, not optional as this ticket's guardrails
  anticipated ("select ZERO sender emails if the form allows it"). Both "Save as Draft" and
  "Launch Campaign" are disabled (no-op on click) until at least one sender-email checkbox is
  checked. The Internal test workspace has exactly one sender email
  (`ian.johnson@prospectchambermedia.com`) — its domain suggests it may be tied to a real
  client ("Chamber Media" / "Chamber Media Secondary" appear as separate client rows in the
  client picker), so it is **not confirmed disposable**. It was selected for both test
  campaigns since (a) it was the only option the form would accept, (b) this flow never
  attaches leads at creation time regardless of sender selection (confirmed: both test
  campaigns showed `total_leads: 0` throughout), so no email could actually have been sent from
  it in either case, and (c) the whole Internal workspace is the designated test sandbox per
  this ticket's own instructions. Flagging in case the actual mailbox turns out to need
  protecting more carefully in future test passes — a dedicated disposable test sender in this
  workspace would remove the ambiguity.
- **EmailBison's `DELETE /api/campaigns/{id}` is async ("queued for deletion")**, not
  immediate — confirms the same async-queue pattern already documented for
  `attach-leads` in `docs/features/emailbison-push/api-research.md`. A `DELETE` call returns
  `200 {"data":{"success":true,"message":"<name> has been queued for deletion."}}` immediately,
  but a `GET` right after still shows `status: "pending deletion"`, not a 404. It took under 20
  seconds to fully clear (404 on GET-by-id, absent from the list) in this test. Worth noting for
  any future scripted cleanup that polls for confirmation rather than assuming synchronous
  deletion.
- Browser automation hit some tooling flakiness unrelated to the app itself: `Page.captureScreenshot`
  timed out intermittently and the tab's reported viewport briefly collapsed to `337x37` for
  part of this session; worked around via `read_page`/`find`/`form_input`/`javascript_tool`
  instead of screenshots for the affected portion. No indication this reflects an app-level
  issue — the DOM/network layer remained fully responsive throughout.
- The `Claude QA Verify Co` company (used to scope the "Add to Campaign" flow to a single company
  via search, so as not to touch the other ~109,760 companies in this view) is a pre-existing
  leftover test record from issue #83's QA session, not something created by this pass — left
  untouched, out of scope for this ticket's cleanup.
- Only the Companies-page wizard (#100) was exercised end-to-end; the People-page wizard (#101)
  shares the same component logic and was not independently re-driven through the UI once #103
  and #104 were confirmed to block the shared code path — filed issues note this component is
  duplicated between `components/companies/push-to-emailbison-campaign-button.tsx` and
  `components/people/push-to-emailbison-campaign-button.tsx`, so both are almost certainly
  affected identically.

## Scope not covered

- Did not complete a fully-successful draft or launch through the actual app UI — both paths
  are currently blocked by #103/#104 before completion is possible with default values.
- Did not verify `resumeCampaign` against a campaign that actually has leads attached (that
  would require using the separate, explicitly-out-of-scope "push people to campaign" action
  per this ticket's guardrails) — so it's unconfirmed whether `resumeCampaign` succeeds
  end-to-end once a campaign has leads. Only the "leads still empty" failure path was observed
  live.
- Did not independently re-drive the People-page wizard (#101) through the UI (see note above).

## Re-verification pass (2026-08-04, same day, after #103/#104 fixes)

Re-ran this QA pass against the same Internal test workspace after commits `08dffdf`
(Companies) and `cb9a38e` (People) landed, which drop `"UTC"` from `TIMEZONE_OPTIONS`, default
`createForm.timezone` to `"America/New_York"`, and force step 1's wire `wait_in_days` to `1`
regardless of UI state. Driven the same way (local dev server, `localhost:3000`, Chrome
automation, `claude-qa-test@scaletopia.local`), reusing the pre-existing `Claude QA Verify Co`
company and `Claude QA Verify Person` person records from issue #83's QA session so as not to
touch the other ~109k companies / people in this view.

### Result summary

| Area | Result |
| --- | --- |
| Companies wizard — timezone default | ✅ Pass — dropdown default is now `America/New_York`; `UTC` is no longer an option in the list at all |
| Companies wizard — draft path (default sender/schedule/timezone, filled name+subject+body) | ✅ Pass — `POST .../emailbison-campaigns` returned `200`, campaign `1006` ("Claude Re-Verify Draft - delete me") created and immediately appeared prepended in the campaign picker dropdown |
| People wizard — draft path (same field pattern) | ✅ Pass — `POST .../emailbison-campaigns` returned `200`, campaign `1011` ("Claude Re-Verify People Draft - delete me") created. Confirmed via captured request body: wire payload sent `"timezone":"America/New_York"` and `"waitInDays":1` for step 1, even though the People wizard (unlike Companies) does render a visible "Wait ... days" input for step 1 defaulting to `0` — the fix's server-side override (`index === 0 ? 1 : ...`) applies regardless of what the UI shows, so it works correctly despite the UI-level inconsistency between the two components. Not a blocker, just a cosmetic note. |
| Companies wizard — launch path | ✅ Pass (gets past #103/#104), and correctly reaches the documented #105 leads-required failure — see below |
| Console errors | None observed on either draft submission |

### Launch-path detail (Companies)

Captured the actual request/response via an instrumented `fetch` wrapper in the page (not just
the HTTP status code) to confirm exactly which step failed and why. The wire payload for the
launch attempt:

```json
{
  "name": "Claude Re-Verify Launch v2 - delete me",
  "senderEmailIds": ["10473"],
  "schedule": { "...": "...", "timezone": "America/New_York" },
  "sequenceSteps": [{ "...": "...", "waitInDays": 1, "threadReply": false }],
  "launch": true
}
```

This confirms both fixes are live in the actual outgoing request: `timezone` is
`America/New_York` (not `UTC`), and step 1's `waitInDays` is `1` (not `0`). The orchestrator
(`createEmailBisonCampaign` in `lib/emailbison/campaigns.ts`) ran `createCampaign` →
`attachSenderEmails` → `createCampaignSchedule` → `createSequenceSteps` cleanly — no 422 at any
of those steps — and only failed at the final `resumeCampaign` call, with:

```json
{
  "error": "Campaign created but launching (resume) the campaign failed: EmailBison campaign resume failed with status 400: {\"data\":{\"success\":false,\"message\":\"This campaign is incomplete and cannot be launched. Campaigns should have a completed sequence and schedule, and should have leads and sender emails.\"}}"
}
```

This is exactly the #105 discrepancy already documented (the flow never attaches leads at
creation time, so an immediate launch always 400s on "should have leads"). **No new or
different failure mode was found — #103 and #104 are confirmed fixed.**

One implementation note worth flagging for the team (not a blocker, not something this ticket
asks to fix): `app/api/clients/[id]/emailbison-campaigns/route.ts`'s `POST` handler catches
*every* thrown error from the orchestrator — including the expected #105 400 — and always
responds `502` to the browser. So what's semantically "the documented, expected leads-required
failure" and what would be "a genuine new bug" are currently indistinguishable from the
browser's `502` alone; you have to read the JSON error body's message to tell them apart (as
done above). This pass did that read explicitly, so the distinction here is confirmed, not
assumed — but a future pass (or the eventual "attach leads" work referenced in #105) may want
the route to pass through EmailBison's actual status code (400) instead of collapsing every
failure to `502`, so the UI/console can show a more accurate error.

### Cleanup

All six test campaigns created during this pass — `1006` (Companies draft), `1007`/`1008`
(Companies launch attempts before the diagnostic instrumentation was added), `1009` (an ad hoc
direct-API probe with an intentionally malformed payload, made while diagnosing the 502 —
harmless, no real state), `1010` (Companies launch, the confirmed-clean attempt captured above),
and `1011` (People draft) — were deleted via `DELETE /api/campaigns/{id}` and confirmed gone
(`404` on `GET /api/campaigns/{id}` for all six, and absent from `GET /api/campaigns`'s full
list, which after cleanup shows only the pre-existing `949: Testing Spintax`) after EmailBison's
~15s async deletion queue. Script: `.scratch/eb-cleanup-reverify.mjs` (not committed).

### Net result

**#103 and #104 are confirmed fixed.** Both the Companies and People wizards' draft path now
succeed end-to-end with default field values (no 422 on schedule or sequence-steps). The launch
path on Companies gets cleanly past both previously-blocking steps and reaches
`resumeCampaign`, which fails only with the already-documented, expected #105
leads-required 400 — no new regression introduced by the fix.
