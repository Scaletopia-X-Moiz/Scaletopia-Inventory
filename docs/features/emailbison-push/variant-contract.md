# EmailBison A/B split-test variant contract (verified)

Live-verified against the Internal workspace (`send.scaletopia.io`) and EmailBison's own
OpenAPI spec (self-hosted at `/api/reference.openapi` — the **only** authoritative source;
the public `bcharleson/emailbison-cli` docs and its `bison-sequences` skill are **wrong**
for this instance). Fixes the 404 from issue #143, where variant linking was inferred (in
`76c8cbb`) and never checked against a live workspace.

## The model

EmailBison has **no letter concept**. A campaign has exactly **one** sequence. A step is a
plain sequence step; a *variant* is just another step in that same sequence with:

- `variant: true` (boolean — **not** the string `"B"`), and
- `variant_from_step_id: <baseStepId>` (the id of the base step it splits from; required
  whenever `variant` is true).

Multiple variants of one base step are each `variant: true` pointing at the **same** base
id, distinguished only by a unique `order`. The base step is `variant: false`.

## The flow (as implemented in `lib/emailbison/campaigns.ts`)

1. **Create base steps** — `POST /api/campaigns/{campaign_id}/sequence-steps`
   `{ title, sequence_steps: [...] }`. The response `data.id` is the **sequence** id
   (== `campaign.sequence_id`) — keep it; it is the id the linking PUT needs. `createSequenceSteps` returns it.
2. **Create each variant as its own step** — the same POST with a single-element
   `sequence_steps`. This does **not** create a new sequence: it **appends** to the
   campaign's one sequence and returns **all** steps, with the newly-created one **last**
   (not `[0]`). Read the new step id from the end of the array.
3. **Link them all in one PUT** — `PUT /api/campaigns/v1.1/sequence-steps/{sequence_id}`
   with the **whole** sequence:
   ```json
   {
     "title": "...",
     "sequence_steps": [
       { "id": 2442, "email_subject": "...", "order": 1, "email_body": "...", "wait_in_days": 1, "variant": false },
       { "id": 2443, "email_subject": "...", "order": 2, "email_body": "...", "wait_in_days": 1, "variant": true, "variant_from_step_id": 2442 }
     ]
   }
   ```
   Each step requires `id, email_subject, order, email_body, wait_in_days`; variant steps
   additionally require `variant: true` + `variant_from_step_id`. `order`s must be unique
   (same-order → 422 "duplicate value"). The EmailBison-assigned `order`s are read back via
   `GET /api/campaigns/v1.1/{campaign_id}/sequence-steps` (`getSequenceSteps`) and echoed
   unchanged.

Live read-back after the PUT confirms the pairing persists:

```json
{ "id": 2442, "order": 1, "variant": false, "variant_from_step_id": null },
{ "id": 2443, "order": 2, "variant": true,  "variant_from_step_id": 2442 }
```

## What was wrong before (the 404)

| # | Old code | Reality |
|---|----------|---------|
| 1 | `PUT /api/campaigns/sequence-steps/{stepId}` with a thin `{variant, variant_from_step}` body | path id is the **sequence** id, body is the **whole** sequence; the by-step path 404s `record_not_found: {sequence}`, and the thin body 422s |
| 2 | field `variant_from_step` | must be **`variant_from_step_id`** |
| 3 | `variant: "B"` (string) | must be **`variant: true`** (boolean) — else 422 "variant field must be true or false" |
| 4 | new variant id = `steps[0]` | the new step is **last**; `[0]` is the base step |

Notes: the by-step endpoint (`/api/campaigns/sequence-steps/{sequence_id}`) is marked
**deprecated** in the spec; the current one is **v1.1**. The letter-based `VARIANT_LETTERS`
concept does not exist in the API — letters survive only as human labels in error messages.

## Evidence

Verification scripts under `.scratch/` (Internal workspace, create-only, no deletes):
`eb-variant-verify.mjs` (reproduces the 404), `eb-variant-v11.mjs` (real field
names/types), `eb-variant-DEFINITIVE.mjs` (end-to-end proof of the v1.1 full-sequence PUT),
and `eb-variant-app-flow-probe.mjs` (proves the app's exact flow: non-v1.1 create →
`data.id` == v1.1 `sequence_id`, new step last, v1.1 GET sees non-v1.1-created steps, PUT
links). OpenAPI spec saved at `.scratch/eb-openapi.yaml`.
