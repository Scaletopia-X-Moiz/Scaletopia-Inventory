# Icypeas Email Verification API — Integration Research Spec

**Purpose:** Evaluate replacing MillionVerifier (real-time single-email GET) with Icypeas for email verification in this repo (`lib/millionverifier/verify.ts`, `lib/verify/reverify.ts`, the reverify routes).

**Author:** Research agent · **Date:** 2026-08-16 · Primary sources only (icypeas.com / api-doc.icypeas.com).

---

## ⚠️ CRITICAL FINDING #1 — Icypeas verification is ASYNCHRONOUS (submit → poll / webhook)

There is **no synchronous/real-time single-email verification endpoint**. `POST /api/email-verification` **submits a job** and returns only an acknowledgement with an item `_id` and `status: "NONE"` (queued). You then either **poll** `POST /api/bulk-single-searchs/read` by that `_id` until the item reaches a terminal status, or receive a **webhook**. Our current flow (button click → single `await verifyEmail()` → write result to DB → UI updates, all in one HTTP request) **cannot be reproduced 1:1** without adding polling or a webhook receiver. Details and remediation in §4 and §7.

## ⚠️ CRITICAL FINDING #2 — Icypeas has only a 4-value "certainty" scale; no `catch_all` or `disposable`

Icypeas returns a `certainty` field with exactly four tokens: `very_sure` / `ultra_sure`, `probable`, `undeliverable`, `not_found`. There is **no `catch_all`, no `disposable`, no `risky`, no role/free flag**. Our `email_status` column and the badge component (`ok | catch_all | invalid | unknown | disposable`) will lose the `catch_all` and `disposable` distinctions. Mapping table and gaps in §5.

## ⚠️ CLARIFICATION — HMAC-SHA1 is for WEBHOOK verification, NOT for signing our requests

The task brief expected an HMAC-SHA1 request-signing scheme. That is **incorrect for outbound requests**. Outbound API calls authenticate with a **plain API key in the `Authorization` header** (no signature, no timestamp). HMAC-SHA1 (with a separate **API secret**) is only used **optionally** to verify the authenticity of **inbound webhook** payloads Icypeas sends us. Full detail in §2.

---

## 1. Docs URLs actually used + freshness/accuracy caveats

All primary sources, all under the official docs host `api-doc.icypeas.com` and the main site `icypeas.com`:

| Page | URL |
|---|---|
| Getting started (auth for requests) | https://api-doc.icypeas.com/getting-started/ |
| Verify a single email address | https://api-doc.icypeas.com/find-emails/email-verification/ |
| Retrieve search results (poll) | https://api-doc.icypeas.com/fetch-results/search-item/ |
| Fetch bulk searches' info / progress | https://api-doc.icypeas.com/fetch-results/bulk-search-files/ |
| Check progress (poll vs webhook) | https://api-doc.icypeas.com/check-progress/ |
| Result status values | https://api-doc.icypeas.com/how-works/search_statuses/ |
| Certainties (verification result values) | https://api-doc.icypeas.com/how-works/certainties/ |
| MX providers | https://api-doc.icypeas.com/how-works/mx_providers/ |
| Rate limits | https://api-doc.icypeas.com/how-works/rate_limits/ |
| Credit cost | https://api-doc.icypeas.com/how-works/credit-cost/ |
| Push notifications — setup (HMAC webhook verify) | https://api-doc.icypeas.com/push-notifs/setup-notifications/ |
| Push notifications — each item update (payload) | https://api-doc.icypeas.com/push-notifs/each-item-update/ |
| Useful information (index) | https://api-doc.icypeas.com/category/useful-information/ |

**Caveats:**
- The docs are a client-rendered (Docusaurus) site. The **"Response 200" example bodies on the endpoint pages render inside interactive tabs that do not appear in scraped text**, so I could not capture the endpoint pages' own success-response JSON verbatim. I reconstructed the real result shape from the **webhook "each item update" page**, which carries the identical `results` object, plus the acknowledgement shape quoted verbatim on the "Retrieve search results" page. Where a body is reconstructed rather than quoted verbatim, it is flagged inline.
- The certainties list was confirmed **verbatim via a full browser render** of the Certainties page (not just the scraper), so the "only 4 values" finding is high-confidence.
- Docs are undated/unversioned — there is a single current version at `api-doc.icypeas.com` (no `/v1`, `/v2` paths were found). Credit-cost page self-notes it is "subject to change at any time."

---

## 2. Authentication (full scheme)

### 2a. Outbound API requests — API KEY ONLY (no HMAC, no timestamp)

Source: https://api-doc.icypeas.com/getting-started/ — "Two headers are needed to run a query against the API":

1. `Authorization` header containing **your API key (and ONLY your API key)** — note: **raw key, no `Bearer ` prefix.**
2. `Content-Type: application/json`.

Verbatim curl example from the getting-started page (endpoint is `email-search` in their example; same auth for `email-verification`):

```bash
curl -H "Content-Type: application/json" \
  -H "Authorization: YOUR_API_KEY" \
  https://app.icypeas.com/api/email-search \
  -d '{ "firstname": "Pierre", "lastname": "Landoin", "domainOrCompany": "icypeas.com" }'
```

There is **no request signature, no timestamp, and no nonce** on outbound calls. The API key is obtained from the Icypeas account (API authorization section).

### 2b. Inbound webhooks — OPTIONAL HMAC-SHA1 verification (uses the API SECRET)

Source: https://api-doc.icypeas.com/push-notifs/setup-notifications/. Icypeas POSTs each webhook to your URL with a body of three fields: `signature`, `timestamp`, `data`. To verify the call really came from Icypeas (explicitly "**an optional step, you do not have to do this**"):

Pseudocode (reconstructed from the documented steps + the field semantics):

```
// You know: the endpoint PATH of YOUR webhook receiver, and your Icypeas API SECRET.
// Icypeas sends: body.timestamp (ISO 8601 UTC), body.signature (hex HMAC-SHA1).

payload   = (endpointPath + timestamp).toLowerCase()   // concatenate path + ISO-8601 timestamp, lowercased
expected  = HMAC_SHA1(key = API_SECRET, message = payload)   // hex-encoded
isValid   = (expected === body.signature)
```

- Algorithm: **HMAC-SHA1**; key = **API secret**; output encoding = **hexadecimal**.
- Message signed = **endpoint path + timestamp, lowercased** (timestamp in **ISO 8601**, e.g. `2023-03-01T04:40:20Z`).
- The signature/timestamp travel **in the JSON body**, not in headers.
- ⚠️ The exact concatenation delimiter (whether path and timestamp are joined with any separator) is not spelled out verbatim in the scraped docs; confirm against the docs' code sample or by inspecting a real webhook before relying on strict verification. Since verification is optional, an MVP can skip it.

### 2c. Credentials summary

**Two credentials exist:** an **API key** (required, for all outbound request auth) and an **API secret** (only needed if you implement optional webhook signature verification). If we poll instead of using webhooks, **only the API key is required**.

---

## 3. Endpoints + request/response examples

Base URL: **`https://app.icypeas.com/api/`** (source: getting-started + every endpoint page).

### 3a. Submit a verification — `POST https://app.icypeas.com/api/email-verification`

Source: https://api-doc.icypeas.com/find-emails/email-verification/

Headers: `Authorization: <API_KEY>`, `Content-Type: application/json`.

Body params:
- `email` — **string, required.** "The email address you want to verify."
- `custom` — object, optional:
  - `webhookUrl` — url, optional. Per-search webhook fired when done.
  - `externalId` — string, optional. Your tracking id (uniqueness NOT enforced by Icypeas — you manage it). Echoed back in results as `userData.externalId`.

Request body (verbatim):
```json
{
  "email": "example-email@icypeas.com"
}
```

**Acknowledgement response (HTTP 200)** — verbatim from the "Retrieve search results" page ("Everytime you do a single search, a `_id` is returned"):
```json
{
  "success": true,
  "item": {
    "_id": "kMnquYkBTs8kZM9ND26h",
    "status": "NONE"
  }
}
```
This is **only an ack that the job is queued** (`status: "NONE"`). It does NOT contain the verification result. Keep the `_id` to poll.

**CAUTION from the docs:** "you should not use this route if you want to make many searches. You need to use the bulk search instead." For per-record button clicks this single route is appropriate; for our bulk reverify we should evaluate `/api/bulk-search` (see §7).

### 3b. Fetch the result — `POST https://app.icypeas.com/api/bulk-single-searchs/read`

Source: https://api-doc.icypeas.com/fetch-results/search-item/

Fetch one item by id (verbatim request):
```json
{
  "id": "kMnquYkBTs8kZM9ND26h"
}
```
Other modes: `{ "mode": "single", "type": "email-verification" }` (list your single searches), `{ "mode": "bulk", "file": "<FILEID>", "limit": 50 }` (list a bulk's items). Pagination via `limit` (default 10, **max 100**), `next` (bool), `sorts` (array).

**Result item shape (reconstructed verbatim from the identical `results` object shown on the webhook "each item update" page, https://api-doc.icypeas.com/push-notifs/each-item-update/):**
```json
{
  "name": "My cool search",
  "user": "#USERID#",
  "file": "#FILEID#",
  "results": {
    "firstname": "Example",
    "lastname": "Email",
    "fullname": "Example Email",
    "gender": "UNKNOWN",
    "emails": [
      {
        "email": "example-email@icypeas.com",
        "certainty": "ultra_sure",
        "mxProvider": "google",
        "mxRecords": ["google.com"]
      }
    ],
    "phones": []
  },
  "order": 0,
  "status": "FOUND",
  "system": {
    "createdAt": "2023-01-01T13:49:49.630Z",
    "modifiedAt": "2023-01-01T13:49:49.630Z"
  },
  "userData": {
    "externalId": "my-custom-id",
    "webhookUrl": "https://www.call-me-when-done.com/my-custom-id"
  },
  "_id": "oSmI5YYBMa6Snk9TvjDA"
}
```
Key fields for us: `status` (processing status, §5a), and `results.emails[0].certainty` (verification verdict, §5b), plus `results.emails[0].mxProvider` / `mxRecords`. On the `read` route this item is wrapped in the route's success envelope (an `items`/list structure); exact wrapper key not captured verbatim (docs render it in a hidden tab) — confirm the outer key at implementation time (likely `items`).

### 3c. Bulk submit / progress (for our bulk reverify path)

- Submit bulk: `POST https://app.icypeas.com/api/bulk-search` — up to **5000 rows/call**, returns `{ "success": true, "file": "<FILEID>", "status": "in_progress" }` (verbatim). Source: rate_limits + search-item pages.
- Progress/stats by file: `POST https://app.icypeas.com/api/search-files/read` with `{ "file": "<FILEID>" }` or `{ "status": "in_progress" | "done" }`. Source: https://api-doc.icypeas.com/fetch-results/bulk-search-files/

---

## 4. Sync vs Async flow — step by step

**Icypeas is submit-then-retrieve. There is no endpoint that returns a verdict in the same response.** Full single-email flow:

1. **Submit:** `POST /api/email-verification` with `{ "email": "..." }` (+ optional `custom.webhookUrl`, `custom.externalId`). → returns `{ success, item: { _id, status: "NONE" } }`. Save `_id`.
2. **Wait for completion**, via either:
   - **Poll:** `POST /api/bulk-single-searchs/read` with `{ "id": _id }` on an interval until the item's `status` is terminal — one of `DEBITED`/`FOUND`, `DEBITED_NOT_FOUND`/`NOT_FOUND`, `BAD_INPUT`, `INSUFFICIENT_FUNDS`, `ABORTED` (see §5a). Poll route limit is **30 calls/min** (§6) — mind it when polling many jobs. Docs call polling the non-preferred option.
   - **Webhook (preferred by docs):** supply `custom.webhookUrl`; Icypeas POSTs the completed item (§3b shape, wrapped as `{ signature, timestamp, data: <item> }`) to your URL when done. "the preferred way to check progress… the most scalable way, as you do not have to care about rate limits."
3. **Read verdict:** from `results.emails[0].certainty`.

**Typical latency:** **Not documented.** Icypeas gives no per-email SLA. Real-time email verification of this kind is usually seconds-to-tens-of-seconds (SMTP probing), but treat this as unknown/variable — the queued `NONE → SCHEDULED → IN_PROGRESS → terminal` lifecycle means latency is not bounded the way MillionVerifier's `timeout=10s` param bounds it. **This is the core UX risk** vs our current instant-result button.

---

## 5. Status/result values → mapping to our internal statuses

### 5a. Search/processing `status` values (item lifecycle)
Source: https://api-doc.icypeas.com/how-works/search_statuses/

| `status` | Meaning | Terminal? |
|---|---|---|
| `NONE` | Queued, not started. | no |
| `SCHEDULED` | Will process next batch. | no |
| `IN_PROGRESS` | Currently verifying. | no |
| `BAD_INPUT` | Missing/invalid input, cannot analyze. | yes (error) |
| `INSUFFICIENT_FUNDS` | Not enough credits. | yes (error) |
| `ABORTED` | Cancelled by you. | yes (error) |
| `NOT_FOUND` / `DEBITED_NOT_FOUND` | Processed; no result / email does not exist. | yes |
| `FOUND` / `DEBITED` | Result found, credits debited. | yes |

For verification, a terminal `FOUND`/`DEBITED` carries the real verdict in `certainty`; `NOT_FOUND`/`DEBITED_NOT_FOUND` means "we don't know if it exists" (equivalent to certainty `not_found`).

### 5b. `certainty` values (the actual verification verdict) — COMPLETE LIST (verified verbatim via full browser render)
Source: https://api-doc.icypeas.com/how-works/certainties/

| `certainty` | Applies to | Meaning (verbatim) |
|---|---|---|
| `very_sure` / `ultra_sure` | all | "99% confidence level: expected bounce rate inferior to 1%." |
| `probable` | all | "95% confidence level: expected bounce rate inferior to 5%." |
| `undeliverable` | email-verification | "The email address does not exist." |
| `not_found` | email-verification | "We do not know if this email address exists or not" |

**That is the entire set for verification. There is no `catch_all`, `disposable`, `risky`, `role`, `free`, or `spam_trap` token.** (Icypeas markets "catch-all verification" but the API collapses catch-all outcomes into the confidence scale rather than exposing a distinct token.)

### 5c. Recommended mapping → our `email_status` vocabulary (`ok | catch_all | unknown | invalid | disposable`)

| Icypeas signal | → our `email_status` | Rationale / caveat |
|---|---|---|
| `certainty = very_sure` / `ultra_sure` | `ok` | High confidence deliverable. |
| `certainty = probable` | `ok` (or a new `risky`) | 95% conf. Maps to `ok`; if we want to preserve the weaker signal, introduce a new status (badge change needed). |
| `certainty = undeliverable` | `invalid` | Mailbox does not exist. |
| `certainty = not_found` | `unknown` | "We don't know if it exists." |
| `status = NOT_FOUND` / `DEBITED_NOT_FOUND` (no email in results) | `unknown` | Same as `not_found`. |
| `status = BAD_INPUT` | `invalid` (or throw) | Malformed input; arguably surface as an error, not a stored status. |
| `status = INSUFFICIENT_FUNDS` | **throw** (do not write) | Mirrors MillionVerifier out-of-credits → throw. |
| `status = ABORTED` | **throw / no-write** | Not a verdict. |

**Mapping gaps (call out to stakeholders):**
- **`catch_all` becomes unreachable.** Nothing in the Icypeas verification response distinguishes a catch-all domain. Existing rows with `email_status = 'catch_all'` will never be reproduced; catch-all addresses will likely land as `probable`→`ok` or `not_found`→`unknown`. This is a **semantic downgrade** for deliverability filtering.
- **`disposable` becomes unreachable.** No disposable/temporary-mail flag is returned. Disposable addresses will map to whatever certainty they score. If disposable detection matters, it must be handled separately (e.g. a local disposable-domain list) — Icypeas does not provide it.
- **`probable` has no lossless home.** Folding it into `ok` hides a real "95% not 99%" distinction. Consider adding a `risky` status if the business cares (requires updating `components/people/email-status-badge.tsx` and any filters).

---

## 6. Rate limits, credits, pricing

Source: https://api-doc.icypeas.com/how-works/rate_limits/ and https://api-doc.icypeas.com/how-works/credit-cost/

**Rate limits (relevant routes):**
- `/email-verification` (single) — **10 calls/sec**
- `/bulk-search` — **1 call/sec, up to 5000 rows/call**
- `/bulk-single-searchs/read` (fetch results / poll) — **30 calls/min**
- `/search-files/read` (bulk progress) — **15 calls/min**

Note the **read/poll route is only 30 calls/min** — a hard constraint on a naive per-item polling strategy for bulk verification. This strongly favors the bulk-submit + webhook (or batched read) approach for our bulk reverify.

**Credit cost:** `/email-verification` = **0.1 credit per tested email** (source: credit-cost page; a search result / benchmark page phrased it as "0.1 per verification"). Terminal `INSUFFICIENT_FUNDS` is returned when credits run out. Credit balance is **not** returned in the verification result object (unlike MillionVerifier's `credits` field) — there is no per-response remaining-credits field documented.

**Pricing tiers:** not on the API docs; on icypeas.com pricing (not fetched for exact numbers here — out of scope of the API integration).

---

## 7. Error responses

Source: https://api-doc.icypeas.com/find-emails/email-verification/ (status codes listed) + validation-errors page.

| HTTP | Meaning |
|---|---|
| `200` (good input) | Job accepted; ack body `{ success: true, item: { _id, status } }`. |
| `200` (validation errors) | Request reached the API but input failed validation — the docs model validation errors as a **200 with an error-carrying body** (exact JSON not captured verbatim — hidden tab; expect a `success: false` / `errors` shape). Treat like MillionVerifier's HTTP-200-with-`error` pattern: inspect the body, not just the status. |
| `401` | Authentication failed (bad/missing API key). |
| `429` | Rate limit exceeded. |

Additionally, **credit exhaustion surfaces asynchronously** as item `status = INSUFFICIENT_FUNDS` (not an HTTP error on submit), and bad addresses as `status = BAD_INPUT` — both only visible after you fetch the item.

---

## 8. Env vars needed

Consistent with the existing `MILLIONVERIFIER_API_KEY` style (server-side only, no `NEXT_PUBLIC_`):

- `ICYPEAS_API_KEY` — **required.** Sent as the raw `Authorization` header value.
- `ICYPEAS_API_SECRET` — **only if** implementing webhook signature verification (§2b). Not needed for a polling-only implementation.

Add to `.env.example` (mirroring the MillionVerifier entry). Base URL `https://app.icypeas.com/api` can be a constant in code (matching how `API_BASE` is a constant in `verify.ts`).

---

## 9. Recommendation — code structure & impact on existing files

### The hard truth
Our stack (`verifyEmail` is one `await` returning a verdict; `reverifyRecord` awaits it and writes immediately; the single-record route returns the result inline) is built on a **synchronous** provider. **Icypeas cannot satisfy `verifyEmail(email): Promise<VerifyResult>` in one round-trip.** Any drop-in `lib/icypeas/verify.ts` that keeps the same signature must **internally submit-then-poll**, turning one call into (1 submit + N reads until terminal), bounded by the 30-reads/min limit.

### Option A (recommended for parity, lowest blast radius) — `lib/icypeas/verify.ts` that submits + polls internally
Mirror `verify.ts`'s exports so `reverify.ts` and the routes barely change:

- Keep exports: `verifyEmail(email, deps): Promise<VerifyResult>`, `VerifyResult`, `VERIFY_STATUSES`, `firstEmail`.
- `VERIFY_STATUSES` stays our 5-token set (mapping target), OR is trimmed if we drop `catch_all`/`disposable` — decide per §5c.
- `verifyEmail` internally:
  1. `POST /api/email-verification` → get `_id`.
  2. Poll `POST /api/bulk-single-searchs/read` `{ id }` with a short interval (e.g. 1.5–2s) and a **timeout budget** (e.g. 20–30s) until terminal status.
  3. Map `certainty`/`status` → our `email_status` per §5c; return `{ email, status, quality: certainty, credits: null }` (no credits field available — set null; `quality` can carry the raw certainty for debugging).
  4. Throw on `INSUFFICIENT_FUNDS`, `401`, timeout, or unexpected — matching the existing throw-means-"leave status unchanged" contract.
- `VerifyDeps`: `{ fetchImpl?, apiKey?, apiSecret? }`.

**Impact:** `lib/verify/reverify.ts` is **unchanged in shape** — it still calls `await verifyEmail(email)` and writes the result. But each verify now takes **seconds, not ~instant**, and can **time out** (new failure mode). `VERIFY_CONCURRENCY=5` chunks now each hold open a poll loop — watch the **30 reads/min** limit: 5 concurrent poll loops at ~2s cadence = ~150 reads/min, which **exceeds the limit**. Lower poll frequency or serialize reads. The two `route.ts` files are **unchanged** in structure (single POST still returns inline once the internal poll resolves; SSE bulk still streams `onProgress`), but every request is now long-lived.

**UX:** The "Reverify" button now shows a spinner for seconds and can fail with a timeout. Acceptable if latency is low, risky if not (latency is undocumented — validate empirically before committing).

### Option B (recommended for bulk, more work) — webhook receiver + bulk-search
For `runPeopleReverify`/`runCompaniesReverify`, submit via `POST /api/bulk-search` (5000 rows/call) with `externalId = row id`, and add a **webhook receiver route** (e.g. `app/api/icypeas/webhook/route.ts`, whitelisted in `proxy.ts` `isPublicPath` since it's cookieless — see MEMORY: proxy.ts gates all `/api/*`) that verifies the HMAC (§2b) and writes `email_status` per incoming item. This removes polling/rate-limit pain and scales, but is a **larger architectural change** (persistent job tracking, out-of-band DB writes, public endpoint) and breaks the current SSE "live progress from a single request" model — progress would instead come from webhook-driven DB updates the client subscribes to or polls.

### Recommendation
- **Ship Option A first** for the single-record button (smallest change, preserves the sync-looking API), **but only after measuring real latency** against a live key. If p95 latency is more than a few seconds, the button UX degrades badly — consider making even the single button async (submit → toast "verifying…" → webhook/poll updates the row).
- **Move bulk to Option B** (bulk-search + webhook) regardless, because the 30-reads/min poll limit makes per-item polling of large filtered views impractical.
- **Get sign-off on the `catch_all`/`disposable` semantic loss (§5c)** before migrating — this changes what our deliverability filters mean, not just the vendor.

---

## 10. Open questions / risks

1. **Latency is undocumented** — the single biggest unknown for the button UX. Must be measured with a live key before committing to Option A.
2. **Verbatim success/error response bodies** for `/email-verification` and `/bulk-single-searchs/read` render in hidden doc tabs and could not be captured 1:1. The result `results` object shape is confirmed via the webhook page; the **outer envelope key** of the `read` route (likely `items`) and the **exact validation-error JSON** should be confirmed against a live call.
3. **HMAC concatenation exactness** (§2b) — the precise delimiter between endpoint path and timestamp isn't quoted verbatim; verify with a real webhook if implementing signature checks (optional).
4. **`catch_all` / `disposable` cannot be produced** by Icypeas verification — confirmed semantic gap vs current data. Disposable detection would need a separate mechanism.
5. **No remaining-credits field** in responses (MillionVerifier returns `credits`); our `VerifyResult.credits` becomes always-`null`. Any UI relying on it must change or drop the field.
6. **Poll rate limit (30/min) vs concurrency (5)** — naive Option A will exceed the read limit; needs a throttled/serialized poller or Option B.
7. **Bulk vs single billing/behavior** — docs explicitly steer high-volume to `/bulk-search`; the single route is "not for many searches." Our bulk reverify should not fan out single-route calls.
8. **API secret provisioning** — confirm the Icypeas account exposes a distinct API secret (separate from the API key) for webhook verification; only relevant for Option B.
```
