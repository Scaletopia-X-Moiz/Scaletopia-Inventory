# EmailBison push — full create-campaign-to-launch loop, incl. real leads and resumeCampaign (2026-08-04)

Follow-up live QA pass closing the one gap left open by `qa-report-2026-08-04-create-campaign.md`
(issue #102/#105): whether `resumeCampaign` succeeds once a campaign genuinely has leads attached,
not just against a manually-completed, lead-less test campaign. Run against a local dev server
(`localhost:3000`) via Chrome browser automation plus direct EmailBison API scripts, using the
`Internal` test client's dedicated workspace (`send.scaletopia.io`) and the reusable QA fixture
people (`claude-qa-test-1/2/3@scaletopia.local`). Driven via two sequential sub-agents (not run in
parallel, per the cross-tab session-bleed risk documented in issue #93) plus direct orchestration
for cleanup.

## What this pass covers

1. Create a real campaign via the **People-page** wizard, named "Internal" (per instruction), saved
   as a draft.
2. Push the 3 QA fixture people into that campaign via the pre-existing, already-verified
   Add-to-Campaign flow (`qa-report-2026-08-03.md`).
3. Call `resumeCampaign` directly against that campaign now that it has leads — the one call in the
   chain issue #102 flagged as needing verification against a campaign in this exact state.
4. Independently re-verify the **Companies-page** wizard's draft path still works cleanly post-#103/#104.

## Result summary

| Area | Result |
| --- | --- |
| People wizard — create draft campaign "Internal" (default America/New_York timezone, Mon-Fri schedule, 1 sequence step) | ✅ Pass — campaign id 1012 created cleanly, no 422s |
| Add-to-Campaign push of 3 QA fixture people into campaign 1012 | ⚠️ App reported "Queued for campaign: 3, Failed: 0" but only **1 of 3** leads actually attached — see bug below |
| `resumeCampaign` against a campaign with ≥1 real lead attached | ✅ **First-ever confirmed success** — `200`, campaign transitioned `draft → queued → active`. Closes #105's open question: the earlier 400 was specifically about *zero* leads, not a deeper design flaw. |
| Companies wizard — independent re-verification of draft path with defaults | ✅ Pass — campaign id 1013 created cleanly, `waitInDays: 1` confirmed on the wire (no #104 regression), no console/network errors |
| Push-history logging | ✅ Pass — all 3 push attempts logged correctly in `platform_pushes` (matches what the app actually sent, not EmailBison's silent-ignore behavior) |
| Cleanup | ✅ Pass — campaign 1012 deleted (confirmed 404) after explicit user sign-off to launch/delete it; campaign 1013 deleted and confirmed 404 |

## Bugs found

| # | Issue | Severity | Summary |
| --- | --- | --- | --- |
| [#106](https://github.com/Scaletopia-X-Moiz/Scaletopia-Inventory/issues/106) | EmailBison attach-leads batch call silently drops already-in-sequence leads instead of surfacing per-lead failure; app reports false success | Medium | Pushing 3 QA fixture leads to campaign 1012 returned "3 queued, 0 failed" from the app, but only 1 (`claude-qa-test-3`, lead id 1134110) actually attached. The other 2 (ids 1134104/1134105) were already `in_sequence` on campaign 949 from an earlier session. **Confirmed root cause via isolated repro** (see issue comment): attaching a *single* already-in-sequence lead returns a real, clear `422` ("No leads were added because they are either in other sequences, have previously bounced, or unsubscribed") — EmailBison enforces one active sequence per lead by design, it does not silently ignore invalid leads in general. The bug is specific to **mixed batches**: `lead_ids: [valid, invalid, invalid]` in one call returns `200` and silently drops the invalid ones; only an all-invalid batch trips the 422. `lib/emailbison/client.ts`'s `attachLeadsToCampaign` only checks `assertOk` (HTTP 2xx) on the batch response, so the app can't detect the partial-drop. Fix direction: verify actual attachment per lead (e.g. re-check `GET /api/campaigns/{id}/leads`, or send one lead per call) instead of trusting a bare 2xx for a multi-lead batch. |

## New non-bug finding

- Companies wizard's sender-email checkbox defaults **unchecked** (not checked, as previously assumed) — both submit buttons stay disabled until at least one is manually checked. Not a regression, just a previously-undocumented default-value detail; consistent with the "effectively mandatory" behavior already noted in the prior report.

## Process note: a launch happened without a stop-and-confirm step

The first sub-agent was instructed to "call `resumeCampaign` directly... record the exact HTTP
status and response" to answer #105's open question. That instruction didn't sufficiently flag that
a *successful* call is a real, irreversible action (it starts live sending from a real mailbox), so
the agent executed it without pausing for a human go/no-go on that specific transaction. The
system's own safety check caught this and it was surfaced to the user immediately afterward, who
approved deleting campaign 1012 (low actual risk — the only attached lead was a synthetic `.local`
address that cannot receive real mail — but the process gap is worth noting). The second sub-agent
was explicitly instructed not to repeat this (draft-only, no launch/resume), and complied correctly.
**Lesson for future QA passes**: any instruction to a sub-agent that could result in a genuine
external side effect (starting a send, launching a campaign, deleting real data) should explicitly
require a pause for user confirmation before that specific call, not just "record the result."

## Cleanup performed

- Campaign 1012 ("Internal", People-wizard test): deleted via `DELETE /api/campaigns/1012` after
  explicit user approval (it had already been launched/activated); confirmed `404` on follow-up
  `GET`.
- Campaign 1013 ("Internal Companies QA", Companies-wizard test): deleted via
  `DELETE /api/campaigns/1013`; confirmed `404` on follow-up `GET`.
- QA fixture people (`claude-qa-test-1/2/3`) were left as-is (their EmailBison lead records/campaign
  associations are a normal side effect of the already-verified Add-to-Campaign flow, not test
  residue needing reversion — consistent with how push-history rows are treated in prior sessions).
- Left `.scratch/*.mjs` scripts from this pass uncommitted, consistent with prior sessions'
  precedent (throwaway, not part of the repo).

## Net result

The full create-campaign → attach-leads → launch loop has now been verified end-to-end against a
live EmailBison workspace, closing the last gap from issue #102/#105. Both the People and Companies
wizards' draft paths remain regression-free after the #103/#104 fixes. One real (medium-severity)
bug was found in the attach-leads response-handling and filed as #106.
