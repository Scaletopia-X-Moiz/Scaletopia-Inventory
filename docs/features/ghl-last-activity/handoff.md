# Handoff: GHL "Last activity" in the data inventory

Written 2026-09-29/30 after a research session. **Superseded in part by §14:**
the feature was built on 2026-09-30 (branch `feat/ghl-last-activity`), so the
"nothing has been built" framing below applies only to §§1-13, which are kept
as the research record. Start at §14 for what actually exists.

## 1. The ask (from the ticket + Loom)

- Every push to GHL already returns a GHL contact ID. Store it (it is already stored, see 4).
- Read each contact's **Last activity** (what the GHL Contacts list shows) back into our database.
- Add a **Last activity filter** to the People table that behaves like GHL's: `is empty`, `is not empty`, `between` (custom range), `within last N days`. Render as friendly relative text ("2 minutes ago", "3 days ago", weeks, months).
- Add a **refresh button** for contacts that are already imported: fetch their latest last activity from the specific sub-account.
- Team feedback (important): ideally keep **all-time activity data** per lead: 1st activity date, 2nd, 3rd, and so on.
- Why it matters: retargeting. Find leads in a campaign that performed well whose last activity is older than 1-2 months, then re-target them.
- Our own additions being considered: on clicking a person, show the last message itself, direction, and type. Keep the table view light (date only).

## 2. The ticket author's assumption was wrong

The Loom assumed GHL's **Last activity = `dateUpdated`** from `GET /contacts/{id}`. That is wrong.

- `dateUpdated` only changes when the **contact record is edited**. It does not change when a message is sent or received.
- The contact's `lastActivity` field does not work either: it was `null` on every contact we read, and it does not even appear in the contact's returned keys for the inbound-SMS contact.
- The UI's "Last activity" comes from the **conversation record**, not the contact record.

Suggested wording for the ticket author (drafted in chat): the assumption that "date updated" equals last activity was wrong; date updated only means the contact was edited; a working source has been found and the full feature is in progress, with a Loom to follow.

## 3. What we verified (with evidence)

All tests ran against the **Internal sub-account only** (location `MeFEd7scikKpI44Utr8N`, named "Internal (DO NOT SETUP)").

1. **Push behavior.** 10 real people (all `@rblaw.net`, from the People table) were pushed to Internal via the app's normal push. Read back with `GET /contacts/{id}`: `lastActivity: null`, `lastSessionActivityAt: null` on all 10, and `dateUpdated` was a few hundred ms after `dateAdded` (creation time only).
2. **Notes do not count.** Adding a note to two of those contacts changed neither `lastActivity` nor `dateUpdated`, and created no conversation. On a fresh test contact with only a note, the UI Last activity column stayed blank.
3. **Inbound SMS.** Contact `z0kJ77ecKHfRCYPrrLd1` received an inbound SMS. `GET /contacts/{id}` showed `lastActivity: null` and an old `dateUpdated`. But `GET /conversations/search?locationId=...&contactId=...` returned `lastMessageDate: 1790282940131` (2026-09-24 20:49:00 UTC), `lastMessageType: TYPE_SMS`, `lastMessageDirection: inbound`. The UI showed the same message date (Sep 25 in the viewer's timezone).
4. **Outbound email.** Five dummy contacts were created directly in GHL (email-only, tagged `zz-test-delete`, addresses were the user's own inbox plus-aliases). Two got a one-off email via `POST /conversations/messages` (`type: Email`, Version `2021-04-15`). Result: the conversation `lastMessageDate` appeared and the UI Last activity column showed "2 minutes ago" with an email icon. Contact `lastActivity` and `dateUpdated` did not move. A manual follow-up sent from the GHL UI moved `lastMessageDate` forward again. The note-only contact and two untouched controls stayed blank.
5. **Wider sample.** On the 30 most recent conversations (of **30,480** in this location), 15 sampled contacts had `contact.lastActivity` null (15 of 15). One contact received an inbound SMS today (Sep 29) while its `dateUpdated` was Sep 12, 2025, which proves `dateUpdated` does not track messages. In 11 of 15 samples `dateUpdated` matched `lastMessageDate`, but only by coincidence: those were no-show events that also edit the contact.
6. All test data was deleted afterwards (see 9).

## 4. Current app state (Scaletopia Inventory repo)

Repo: `/Users/moizali/dev/Client-Work/Scaletopia Inv/Scaletopia Inventory` (Next.js + Supabase). Live Supabase project id: `swfykpknnfunpapzoudn`. There is no `supabase/migrations`; SQL lives in `lib/data/*.sql`.

- **Push path:** `app/api/people/push-to-ghl/route.ts` → `lib/ghl/push-to-ghl.ts` (`runPeopleGhlPush`, 5 at a time, resumed by `offset`/`deadline` from `app/api/internal/push-worker/route.ts`) → `lib/ghl/client.ts` (`pushContactToGhl`).
- **Endpoint used:** `POST /contacts/upsert`, Version `2021-07-28`. Tags are sent separately via `POST /contacts/{id}/tags` (code comments say upsert replaces the tag list). GHL dedupes on phone for the Internal location, per code comments.
- **Contact ID storage already exists:** `platform_pushes.platform_contact_id`, upserted on the unique key `(person_id, client_id, platform)` (schema `lib/data/platform-pushes.sql`). It also sets `people.pushed_to_ghl` and `pushed_to_ghl_at`.
- **The upsert `new` flag** is turned into `deduped` by `extractNewFlag` and then thrown away in `pushOne`.
- `push_job_records` only holds `(push_job_id, person_id, outcome)`. No table has a last-activity column.
- **Credentials:** `clients.ghl_api_key` and `clients.ghl_location_id`, plain columns, read with `supabaseAdmin` in `lib/data/clients.ts`. A `Client` row is a sub-account. Three client rows share the Internal location: slug `testing` (name "Internal"), slug `internal` (name "Testing"), slug `dma` (name "Score More Clients"). Use `testing` for pushes to Internal. Per `docs/features/ghl-push/internal-client-verification.md`, the location is GHL "Internal (DO NOT SETUP)".
- **A person can be pushed to many clients** (`people` has no client column), so any mapping must be per client, like `platform_pushes`.
- **Filter plumbing:** URL parsing in `lib/data/people-search-params.ts` (`parsePersonFilters`), type `PersonListFilters` in `lib/data/people.ts`. Filters PostgREST cannot express go through `needsMatchingRpc` → `people_matching_virtual_filters`; `toFilterOptionsRpcPayload` builds the payload. The ESP filter (T25) shows the cost of a new filter key: six RPCs changed (`people_`/`companies_matching_virtual_filters`, `person_`/`company_filter_options`, `person_`/`company_push_status_counts`), see `lib/data/ticket-25-esp-filter.sql` (rollback in `ticket-25-rollback.sql`).
- **Best model for a per-client filter:** the push-status filter (#127): `lib/data/push-status-filter.ts`, `pushStatus` key with `clientId`, a join on `platform_pushes`, and `PushStatusFilterPopover` in `components/people/filter-slip.tsx` (~line 400). `components/companies/filter-slip.tsx` has the same. Table display: `components/people/people-table.tsx`.
- **People search box `q`** matches `full_name` and `email` with ILIKE. A filtered-view URL is `/people?q=...`. The app's deployed domain is not in the repo (`NEXT_PUBLIC_SITE_URL` is empty in `.env.example`).
- **Data at research time:** 136,870 people. Before our test, `platform_pushes`, `push_jobs` and `push_job_records` were empty and no person had `pushed_to_ghl = true`. There are now **10 `platform_pushes` rows** (see 9).

## 5. The source we will use

**`GET https://services.leadconnectorhq.com/conversations/search?locationId={location}&contactId={contactId}`** (Version `2021-07-28`, works with the same auth as the contacts calls). Needs the conversations read scope on the sub-account's Private Integration token.

Returns `{ conversations: [...], total, traceId }`. No conversation for a contact = empty list = "no last activity" (new contacts).

### Every field on a conversation object (verified live)

| Group | Fields |
|---|---|
| Dates | `lastMessageDate` (ms epoch), `lastManualMessageDate` (ms epoch), `dateAdded`, `dateUpdated` |
| Last message | `lastMessageType` (e.g. `TYPE_SMS`, `TYPE_EMAIL`, `TYPE_CALL`, `TYPE_NO_SHOW`), `lastMessageDirection` (`inbound`/`outbound`/null), `lastMessageBody` (text; empty for calls and no-shows), `isLastMessageInternalComment`, `messageTypes` (array of numbers) |
| State | `unreadCount`, `inbox` |
| Identity | `id` (conversation id), `contactId`, `locationId`, `contactName`, `fullName`, `phone`, `companyName`, `type` (e.g. `TYPE_PHONE`), `tags`, `followers`, `mentions`, `scoring`, `sort` |

The GHL OpenAPI spec (`conversations.json`, saved in the research scratchpad) also lists `lastMessageId` and `lastMessageAction`; these were **not** seen in the live response.

### Contact object (`GET /contacts/{id}`), for contrast

Live keys on the inbound-SMS contact: `additionalEmails, additionalPhones, attributionSource, country, createdBy, customFields, dateAdded, dateUpdated, followers, id, locationId, phone, tags, type`. No usable activity date.

### Other endpoints (checked to exist or documented)

- `GET /conversations/messages/export` (params `contactId`, `startDate`, `endDate`, `sortBy=createdAt`, `sortOrder=asc`, `limit` 10-500, `cursor`; scope `conversations/message.readonly`): returned success on the Internal key. Documented to include non-email messages plus "activity messages" (appointments, opportunity updates). Email needs a separate `channel=Email` call. This is the candidate for all-time history. Message-level fields were **not** inspected.
- `GET /conversations/{conversationId}/messages`: documented; message types include `TYPE_ACTIVITY_APPOINTMENT`, `TYPE_ACTIVITY_CONTACT`, `TYPE_ACTIVITY_OPPORTUNITY`, `TYPE_FORM_SUBMISSION`. Not tested.
- `POST /contacts/upsert` reply: `{ new, contact: { id, dateAdded, dateUpdated, ... } }`. It has no conversation data, so getting the date after a push needs one more call.
- Contact search (`POST /contacts/search`): the mirrored filter list has `dateUpdated`/`dateAdded` and email-related dates but **no last-activity filter**, and results lack the activity date. Filtering must happen in our own database.

## 6. Open question: which field does the UI use?

Everything verified fits **`lastMessageDate`**, but in every test `lastMessageDate` and `lastManualMessageDate` were the same value, so the data cannot separate them.

- `lastManualMessageDate` is presumably the last message a person sent (excluding automated ones). That is an inference from the name, not documented.
- **Do conversation events count?** 26 of the 30 most recent conversations had `TYPE_NO_SHOW` as the last "message" (appointment no-show events), plus 2 inbound SMS, 1 inbound call, 1 outbound call. We do not yet know whether the UI Last activity counts no-shows.

**Checks still owed** (both need read-only calls, then a look at the UI):
1. Contact `vnIZJvh1NqjP1MconDSB` (inbound SMS on Sep 29 20:13 UTC, `dateUpdated` Sep 12, 2025): does the UI Last activity say Sep 29?
2. Contact `EAhzGidCP3m2hX7TX74S` (`TYPE_NO_SHOW`, Sep 25 13:03 UTC): does the UI say Sep 25, or an older date? If older, exclude `TYPE_NO_SHOW` from our number.
3. Find a contact where `lastManualMessageDate` differs from `lastMessageDate` (for example an automated message, or a no-show after a manual message) and compare against the UI to decide between the two fields.

Also untested: an **inbound email reply** (very likely like inbound SMS), and `lastMessageBody` for an email conversation (verified only on SMS).

Until resolved, treat `lastMessageDate` as the working source and record it as an assumption.

## 7. Design direction to diagnose next

The user wants more than the date:

- **Table view:** only a light "Last activity" column (one timestamp, shown as relative time) plus the filter. This keeps DB load low.
- **Detail on click:** when someone clicks a person, show the last message text, type and direction (and possibly more history). These details are **not** loaded with the table; they are fetched only on click, either live from GHL (`conversations/search`, later `.../messages`) or from a stored copy. Decide: live fetch (no extra storage, rate-limit exposure, needs credentials at request time) vs. stored short snippet.
- **Suggested data model to evaluate:** a per-client `last_activity_at` on `platform_pushes` (since it is already unique per person, client, platform), plus optional `last_message_type`/`last_message_direction`. A separate activity-events table only for the all-time history phase. Body text is real lead text and can be long; truncate or fetch on demand.
- **Filter:** same shape as the push-status filter: `{clientId, op, from, to, days}` checked against the per-client date. New key must be added to the ESP-style RPC set, so plan for the six-RPC change and a rollback file.
- **Refresh button:** one conversations call per stored contact ID. About 1,300 contacts at under 10 requests per second is roughly 2.5 minutes. Best modeled as a background job like push jobs (the app already has a push-worker cron every minute).
- **After push:** an extra lookup per contact is needed, since upsert returns nothing about conversations. New contacts will be empty.
- **All-time history (1st, 2nd, 3rd activity):** GHL has no timeline endpoint; the audit log, workflow/campaign history and past values of any date are not retrievable. Rebuild from messages export (plus email channel, notes, appointments), and log going forward via webhooks (`InboundMessage`, `OutboundMessage`, `NoteCreate`, `AppointmentCreate`, etc.). Webhooks probably need a Marketplace app, not just a private integration token (unverified). Recommend phase 2.
- **Suggested agent split** (discussed, not agreed): database (columns, filter key, Supabase branch first), GHL sync (push-time read plus refresh job with rate limiting), UI (column, filter, refresh button, click-through panel), history (phase 2), then a reviewer.

## 8. Rate limits and API gotchas

- Burst 100 requests per 10 s; 200,000 per day per Marketplace app per location (current usage is in response headers).
- **Cloudflare blocks Python's default user-agent** on `services.leadconnectorhq.com` (HTTP 403, error 1010). curl and Node work; for Python set a normal descriptive `User-Agent`.
- `POST /contacts/search` uses `page`/`pageLimit` plus `searchAfter:[sortValue, id]`; the key must be `searchAfter`, not `startAfter`, or later pages come back empty. `GET /contacts/` is deprecated.
- API v2 has no bulk contact create. Pushing N leads means N upserts. The UI CSV import returns no IDs.

## 9. Test cleanup status

Done:
- The 5 dummy GHL contacts (`ZZTest1-5`) were deleted and returned 400 afterwards.
- The 5 `people` rows with `source = 'zz-test-delete'` were deleted.
- The local token file in the session scratchpad was deleted (twice).

Still open:
- **The 10 `@rblaw.net` contacts** pushed to Internal still exist in GHL, and their 10 `platform_pushes` rows and `pushed_to_ghl` flags are still in the database. Two of them (Holden `tPcY9Z7WLnB0o7DReLHA`, Cerasa `oL2aqYtorHCxsN9H2hap`) have one test note each. Decide whether to delete or keep them as fixtures.
- **Revoke the Private Integration token.** It was pasted into the chat, so it is in that conversation's history. It is not stored in this file or in the repo.

## 10. Caveats

- All live evidence is from the Internal sub-account. Other sub-accounts were never touched.
- The GHL API docs' contact search filter reference could not be rendered, so filter names are from a third-party SDK that mirrors it (unverified as official).
- Research scripts (`ghltest.py`, `ghl-read-dates.mjs`, `dump.py`) lived only in the session scratchpad, not in the repo, and their token file is gone.

---

## 11. RESOLVED (2026-09-30): use `lastMessageDate`

Section 6's open question is closed. Evidence gathered live against the Internal
sub-account (`MeFEd7scikKpI44Utr8N`), read-only, 4,000 unique conversations
sampled by recency out of 30,481.

### 11.1 Credential correction — §4 and §5 were wrong about which client row to use

Three `clients` rows share the Internal location. Their `ghl_api_key` values are
**three different tokens with different scopes**:

| slug | name | `/contacts/` | `/conversations/search` |
|---|---|---|---|
| `internal` | Testing | 200 | **200** |
| `dma` | Score More Clients | 200 | **200** |
| `testing` | Internal | 200 | **401 not authorized for this scope** |

The handoff said to use `testing`. That token is contacts-only and **cannot read
conversations at all**. Use `internal` (or `dma`) for any conversations work.
The GHL Private Integration UI shows all 164 scopes selected, so this is a stale
token stored in the row, not a missing scope in GHL.

**Action owed:** re-issue the `testing` row's token, or point the feature at the
`internal` row. Any sub-account that will support the refresh button needs its
token checked the same way — a per-client scope audit is still outstanding.

### 11.2 What `lastManualMessageDate` actually is

Cross-tab over 1,500 recent conversations:

|  count | type / direction / manual |
|---|---|
| 1201 | `TYPE_SMS` / outbound / **NULL** |
| 109 | `TYPE_CALL` / inbound / set |
| 87 | `TYPE_NO_SHOW` / null / **NULL** |
| 82 | `TYPE_SMS` / inbound / set |
| 18 | `TYPE_SMS` / outbound / set |
| 3 | `TYPE_CALL` / outbound / mixed |

`lastManualMessageDate` is populated when the **last** message was
human-originated (inbound from the lead, or an outbound a rep typed by hand).
It is NULL for automated/bulk outbound and for activity events like no-shows.

**It is not an independent high-water mark.** Across 4,000 conversations there
were **zero** cases where it held a distinct older value than `lastMessageDate`
— it is either NULL or equal to `lastMessageDate` (sub-5ms jitter aside). It
behaves as a flag ("was the most recent event human-originated?"), not as a
separate date. The 12 "divergences" in the first pass were 1-millisecond write
jitter, not real gaps.

### 11.3 Why `lastMessageDate` wins

1. `lastManualMessageDate` is NULL on **85.9%** of conversations. A column built
   on it would be blank for most of the table.
2. It carries no date `lastMessageDate` doesn't already carry (0 of 4,000).
3. Prior research (§3.3) eyeballed contact `z0kJ77ecKHfRCYPrrLd1` in the UI and
   saw the message date. Both fields are identical there, so that contact cannot
   discriminate — but combined with (1), the UI cannot be reading
   `lastManualMessageDate` or its column would be empty for most contacts.

**Decision: store `lastMessageDate`.** Record `lastMessageDirection` and
`lastMessageType` alongside it (see 11.5).

### 11.4 Still owed: one 30-second UI check (no-shows)

Does the UI count activity events? Open contact **`EAhzGidCP3m2hX7TX74S`**
(hilal@scaletopia.io) in the Internal sub-account Contacts list:

- `lastMessageDate` = 2026-09-25 13:03 UTC, `lastMessageType` = `TYPE_NO_SHOW`,
  `lastManualMessageDate` = **null**.
- If Last activity shows **Sep 25** → the UI counts no-shows; include them.
- If it shows **blank or an older date** → exclude `TYPE_NO_SHOW`.

This no longer affects the field choice, only whether we filter activity types.
It is also less urgent than §6 implied: no-shows are ~6% of recent conversations
(87/1500), not the 26-of-30 the tiny first sample suggested.

### 11.5 Product note raised by the data

80% of recent conversations end in an **automated outbound SMS**. For the
retargeting use case ("find leads whose last activity is 1-2 months old"), a
last-activity date driven by our own automated sends is misleading — it measures
our outreach, not lead engagement. Storing `lastMessageDirection` lets the filter
offer "last *inbound* activity", which is closer to what the team actually wants.
Worth putting to the team before the filter is designed.

### 11.6 Design clarification from the user (2026-09-30) — append-only history

On §7's all-time history: rather than overwriting a single `last_activity_at`,
on each sync compare the fetched date to the most recent stored value for that
person+client; if it changed, **append a new row** instead of updating in place.
History then accrues as a by-product of normal pushes and refreshes — no
messages-export backfill, no webhooks, no Marketplace app.

Trade-off: it only remembers from first sync onward. Activity predating our first
read collapses into one row. True all-time history stays a phase-2 backfill. For
the stated retargeting use case, forward-looking history is sufficient.

Implied model: `platform_activity_events` (person, client, platform, activity_at,
type, direction, observed_at) as the record of truth, with `last_activity_at`
denormalized onto `platform_pushes` for the table and filter.

---

## 12. RESOLVED (2026-09-30): activity events excluded; automated sends included

Closes the two items §11 left open. Both answered from the UI plus live reads.

### 12.1 The UI does NOT count activity events

Contact `EAhzGidCP3m2hX7TX74S` (hilal@scaletopia.io) shows **blank** Last activity
in the GHL Contacts list, confirmed by screenshot, while `conversations/search`
reports `lastMessageDate` = 2026-09-25 06:03 PDT, `lastMessageType` =
`TYPE_NO_SHOW`.

Reading that conversation's messages explains it: it holds **exactly one entry**,
of type `TYPE_ACTIVITY_APPOINTMENT` (numeric type `31`) — "Handover Sync
(Saqlain<>Hilal)". Not a message at all. The UI ignores it.

**So `lastMessageDate` is not directly usable.** It reflects whatever the last
*event* was, including appointment/no-show activity the UI discounts.

### 12.2 The fix is cheap — no extra API calls

Sampled 1,200 conversations: 87 (**7.2%**) end in an activity event. Pulled the
message list for 30 of those: **30 of 30 contained only activity events, 0 had a
real message underneath.**

Activity-only conversations are appointment records with no messaging history, so
there is nothing to fall back to. The rule is a pure filter on data
`conversations/search` already returns:

```
if (ACTIVITY_TYPES.has(conv.lastMessageType))  lastActivity = null   // show blank
else                                            lastActivity = conv.lastMessageDate
```

where `ACTIVITY_TYPES` = `TYPE_NO_SHOW`, `TYPE_ACTIVITY_APPOINTMENT`,
`TYPE_ACTIVITY_CONTACT`, `TYPE_ACTIVITY_OPPORTUNITY` (prefix-match `TYPE_ACTIVITY`
plus `TYPE_NO_SHOW`).

Caveat: 0-of-30 is a small sample. If a mixed conversation does exist, that
contact's Last activity would read blank when the UI shows the older real message
date. Worth a spot-check during build, not a blocker.

### 12.3 Automated outbound COUNTS — decided by the user

§11.5 asked whether our own automated sends should count. **Decision: yes.** Last
activity means activity of any kind, including automated outreach we initiated.
The user's reasoning: if we haven't reached out to someone even automatically,
that should be visible too.

So: no direction filtering on the stored date, and no "last inbound only" default.
`lastMessageDirection` and `lastMessageType` are still stored as metadata for the
click-through detail panel, and leave the door open to an optional
"last inbound activity" filter later — but the primary column and filter use the
unfiltered date.

### 12.4 Final rule

```
last_activity_at =
  conversations/search(locationId, contactId)
    -> no conversation            => null
    -> lastMessageType is ACTIVITY => null
    -> otherwise                  => lastMessageDate
```

Store alongside it: `last_message_type`, `last_message_direction`.
Ignore `lastManualMessageDate` entirely (§11.2 — NULL 86% of the time, never an
independent value). Ignore `contact.dateUpdated` and `contact.lastActivity` (§2).

**All research questions are now closed. The feature is ready to design.**

---

## 13. VERIFIED against the GHL UI (2026-09-30)

Spot-checked our computed rule against the Internal Contacts list. **All cases
match.** Two apparent mismatches turned out to be display/search artifacts, not
data errors.

| contact | our rule | UI showed | verdict |
|---|---|---|---|
| Nick Dicerbo `+17024000479` | 2024-10-10 12:50 PDT (1.97 yr) | "1 year ago" | match (see 13.1) |
| Todd Morris `+19175750397` | 2024-10-10 12:49 PDT (1.97 yr) | "1 year ago" | match (see 13.1) |
| BESMA `+16508048464` | 2026-09-14 10:11 PDT (16 days) | "2 weeks ago" + phone icon | exact match |
| hilal@scaletopia.io | blank (activity only) | blank | exact match |
| aaman@, kylie@ | blank | blank | exact match |

### 13.1 GHL's relative display FLOORS, it does not round

1.97 years renders as **"1 year ago"**, not "2 years ago". 16 days renders as
"2 weeks ago" (floor(16/7)). Our relative-time formatter must **truncate toward
zero** to match GHL. Rounding would produce off-by-one labels on most rows.

This was the entire source of the apparent mismatch. The underlying dates are
identical.

### 13.2 The `+16072410944` "wrong contact" was a UI search artifact

The Contacts search showed Todd Morris for that query. A duplicate-lookup
confirms the number belongs to contact `z0kJ77ecKHfRCYPrrLd1` (created
2026-09-24, no name, no email), whose true last activity is 2026-09-24 13:49 PDT
— an inbound SMS. GHL's search box returned a stale row; our data is right.

### 13.3 Use the message's own `dateAdded`, not the conversation's date

`conversations/search.lastMessageDate` runs ~1 second later than the message's
own `dateAdded` (12:50:25 vs 12:50:24) — it is the conversation's update stamp.
Immaterial for display, but the export endpoint's `dateAdded` is the true event
time, and it is what we store.

### 13.4 Confirmed final rule

```
last_activity_at = max(dateAdded) over messages from
    GET /conversations/messages/export?locationId&contactId
  excluding messageType matching ^TYPE_(NO_SHOW|ACTIVITY|SYSTEM)
  -> no qualifying message => null (render blank)

display: relative time, TRUNCATED (1.97y -> "1 year ago")
```

One export call per contact yields both the last-activity date and the full
message history. The `conversations/search` endpoint is no longer needed.

---

## 14. BUILT (2026-09-30) — feature complete on `feat/ghl-last-activity`

Everything in §1's ask is implemented and applied. This section records what
was built, every decision that isn't obvious from the code, the
incremental-sync design, benchmark numbers, and what is still owed.

### 14.1 Files

**Schema** (applied to `swfykpknnfunpapzoudn` as migration `ghl_activity`,
read back and verified; purely additive — no existing function rewritten)
- `lib/data/ghl-activity.sql`, `lib/data/ghl-activity-rollback.sql`
  - `ghl_messages` — history, unique on GHL's own `ghl_message_id`
  - `platform_pushes` +`last_activity_at` +`last_message_type`
    +`last_message_direction` +`activity_synced_at`, plus two indexes
  - `ghl_activity_sweeps` — per-client high-water mark + resume cursor
  - `ghl_activity_queue` — durable work list

**Sync**
- `lib/ghl/activity-rules.ts` — the exclusion rule, the body sanitizer, and
  `computeContactActivity`. Pure, no I/O.
- `lib/ghl/conversations.ts` — the two endpoint wrappers, both through the
  existing `requestGetWithRetry`.
- `lib/ghl/sync-activity.ts` — the sync core.
- `lib/ghl/enqueue-activity-sync.ts` — queues a `ghl_activity` push job.
- `lib/data/ghl-activity.ts` — data layer.

**Job wiring**
- `app/api/internal/push-worker/route.ts` — new `ghl_activity` dispatch
  branch; auto-enqueue after a successful GHL push; new activity-log action.
- `app/api/people/refresh-ghl-activity/route.ts` — the Refresh endpoint.

**UI**
- `components/people/people-table.tsx` — "Last activity" column.
- `components/people/activity-drawer-trigger.tsx` — the cell + drawer.
- `components/people/last-activity-filter-popover.tsx` — the filter.
- `components/people/refresh-ghl-activity-button.tsx` — the Refresh button.
- `components/people/filter-slip.tsx`, `components/people/people-results-client.tsx` — wiring.
- `app/api/people/[id]/ghl-activity/route.ts` — the drawer's data.
- `lib/utils.ts` — `ghlTimeAgo`, the truncating formatter.
- `lib/data/last-activity-filter.ts`, `lib/data/people.ts`,
  `lib/data/people-search-params.ts` — the filter contract and plumbing.

**Tests** — `lib/ghl/activity-rules.test.ts` (22),
`lib/ghl/sync-activity.test.ts` (17), `lib/data/last-activity-filter.test.ts`
(11). **50/50 passing.** GHL is stubbed at the `fetchImpl` seam; Supabase is
real, matching this repo's convention.

Lint is clean on every file this branch touches. The one error eslint reports
in `components/people/people-results-client.tsx` predates this work (the
existing `load()` effect) and the repo-wide count is unchanged at 37
problems / 22 errors, verified by stashing the branch and re-running.

Two migrations were applied, both purely additive (no existing function,
column or index altered): `ghl_activity` and `ghl_activity_sweep_cursor`.

### 14.2 The incremental-sync design

The hypothesis in the brief was verified live and then improved on.

**Verified.** `GET /conversations/search?locationId&limit=100&sortBy=last_message_date&sort=desc`
returns 100 conversations per call, each with `contactId` and
`lastMessageDate`, and pages on `startAfterDate` with **zero overlap** between
pages. `page` is confirmed ignored — `page=2` returned a first row identical
to page 1's. Rate-limit headers on the live response: `x-ratelimit-max: 100`,
`x-ratelimit-interval-milliseconds: 10000`,
`x-ratelimit-daily-remaining: 199,604`. The location holds 30,481
conversations, so a full sweep is ~305 calls.

**The improvement.** The brief's design is one full sweep per run (~305 calls).
But the sort key *is* the field being watched, so any conversation whose
activity moved sorts above the previous run's newest value. The sweep
therefore **stops the moment a page falls entirely at or below the stored
high-water mark** (`ghl_activity_sweeps.last_message_date_ms`). A steady-state
run is 1-2 conversation calls, not 305. The full 305-call pass happens once,
on the first sync of a location; `full_sweep_completed_at` records that it
happened, and until it has, early stopping is disabled because there is no
value below which "nothing changed" is a safe assumption.

**The correction the hypothesis was missing.** A GHL push often *dedupes* onto
an existing contact whose conversation is years old — far below the sweep's
mark, so an incremental sweep will never surface it. Any contact with
`activity_synced_at IS NULL` ("cold") is therefore always queued for one
direct export call, regardless of the sweep. This is a one-time cost per
contact, and it is what makes the incremental path correct rather than merely
fast.

**Then three filters before any export call is made:**
1. The contact must have a `platform_contact_id` we pushed. The location holds
   30k conversations; we own ~1.3k.
2. Its swept `lastMessageDate` must differ from the stored `last_activity_at`.
3. Compared with a **1.5s tolerance**, because `conversations/search`'s
   `lastMessageDate` is the conversation's update stamp and runs ~1s later
   than the message's own `dateAdded` that we store (§13.3). Exact comparison
   would mark every contact as changed forever and silently turn the
   incremental sync back into a full one. There is a regression test for this.

**Resumability, and a bug this design nearly shipped with.** Both phases write
to `ghl_activity_queue` and the fetch phase deletes each batch as it
completes, so *the queue is the cursor*: a killed invocation resumes by
draining what is left, with no offset arithmetic. The sweep only runs on a
tick that finds the queue empty, so a resumed job never re-sweeps.

The sweep itself needed the same treatment, which was missed on the first
pass. A first full sweep is ~305 **sequential** conversation calls; against
the live Internal location each takes long enough that the pass does not fit
in one worker tick's 240s budget. Without a persisted position, every tick
would restart at page 1, re-read the same opening pages, never reach the end,
and therefore never set `full_sweep_completed_at` — so early stopping, the
entire point of the design, would never switch on and the sync would silently
run as a permanent partial sweep. Fixed by
`ghl_activity_sweeps.sweep_cursor_ms` (migration `ghl_activity_sweep_cursor`,
also additive): an interrupted pass records where it stopped and the next one
resumes from there; a completed pass clears it. Because the high-water mark
only ever moves forward, a resumed pass — whose pages are older than the mark
by definition — cannot drag it backwards. There is a regression test.

**Rate limits.** Concurrency is 5 (same as `GHL_PUSH_CONCURRENCY`), giving
~10 req/s against the 100-per-10s burst ceiling — deliberately half, because a
sync and a push to the same client share one location budget. 429/5xx and
`Retry-After` are handled by the existing `requestGetWithRetry`. Worst case
(first full sweep of every location) is ~305 + 1,300 calls, well inside the
200,000/day ceiling.

### 14.3 Decisions

- **Extended `push_jobs.platform` with `ghl_activity` rather than cloning the
  queue.** The deciding reason is rate limiting: `claim_next_runnable_job`
  serializes per *client*, and a sync and a push to the same client hit the
  same GHL location's burst budget. A parallel queue would happily run both at
  once and make them fight. It also inherits the reaper, the lease heartbeat,
  the self-chain and the Push Activity panel for free. Cost: the sync reuses
  `created`/`updated` on the job row to mean "moved"/"skipped".
- **The filter touches NO filter RPC.** It resolves an id set straight off
  `platform_pushes` through PostgREST and intersects in app code, exactly like
  the existing `pushJobId` filter. `lib/data/ticket-25-esp-filter.sql:23-31`
  records that adding a dimension to `people_matching_virtual_filters` cost a
  ~60x regression on the no-filter call, and that the id-set form then *timed
  out* inside `person_push_status_counts`. Avoiding those functions entirely is
  worth more than facet precision. **Consequence:** facet counts in the filter
  slip are not scoped by an active last-activity filter — the same limitation
  `pushJobId` already has. The row count in the results header is correct.
- **The filter is scoped to people pushed to that client.** "Is empty" means
  "pushed to this sub-account and nothing has happened", not "all 136k people
  including the ones we never pushed". That is the question the retargeting use
  case asks, and it keeps the id set in the thousands rather than the hundreds
  of thousands.
- **The table column shows the max across all clients**, because the People
  table has no current client. The filter, which does have one, is per-client.
- **The column is fetched per rendered page**, not embedded in `LIST_COLUMNS`.
  An embed would fan out per person on every path including the 136k-row export
  fetch; a scoped-by-id lookup costs ~280ms for 50 rows and leaves the list
  query's plan untouched.
- **Body is stripped to text and capped at 4,000 chars**, with the untouched
  message kept in `ghl_messages.raw`. The column renders a preview in a 24rem
  drawer; it is not an email archive. `raw` is what makes capping safe.
- **Activity events are filtered at write time**, so `ghl_messages` is exactly
  the set both the date and the drawer are computed from and the two cannot
  disagree.
- **The drawer reads our database, never live GHL.** A user may open a dozen
  rows in a row; a live call each would add a second of latency and burn the
  location's budget.
- **`ghlTimeAgo` is a new function, not a change to `timeAgo`.** `timeAgo`
  rounds and has no weeks tier; it renders every other timestamp in the app and
  changing it would shift them all.
- **A missing-scope 401 fails that client's job with an actionable message**
  and does not crash the worker (§11.1's stale `testing` token). Verified live.
- **A permanently failing contact is dropped from the queue, not retried
  forever** — one broken contact must not block the queue. A cold contact stays
  cold, so the next run retries it anyway.

### 14.4 Benchmarks

No-filter People path, 5 runs each, median (live project, 136,870 people):

| call | before | after |
|---|---|---|
| people list page 1 (50 rows, count exact) | 1,004 ms | 1,175 ms |
| `person_filter_options` (no filters) | 12,399 ms | 12,584 ms |

Both differences are inside this project's run-to-run noise (the list call's
max ranged 1,018 → 1,782 ms across samples on an unchanged query). **No RPC was
modified and no column was added to `LIST_COLUMNS`**, so no plan change is
possible; the numbers confirm it.

Measured GHL-side cost of a sweep page against the live Internal location
(8 sequential pages, `startAfterDate` cursor):

| | |
|---|---|
| one 100-conversation page | median **451 ms** (min 397, max 680) |
| conversations in the location | 30,481 → 305 pages |
| **a full sweep, sequential** | **~138 s** |

138s fits inside one worker tick's 240s budget — but only just, and not on a
larger location or a slower day. That is the margin the resume cursor exists
to cover.

New DB costs, both additive and paid only where used:

| call | median |
|---|---|
| per-page last-activity lookup (50 ids) | 299 ms |
| last-activity filter id-set (one client, "is not empty") | 283 ms |

`person_filter_options`'s ~12s is a **pre-existing** condition, unchanged by
this work and unrelated to it. It is worth its own ticket.

### 14.5 Still owed / risks

1. **§9's cleanup is still open.** The 10 `@rblaw.net` contacts and their
   `platform_pushes` rows are still there, on the `testing` client — whose
   token cannot read conversations. So the one client with real pushed contacts
   is the one that cannot sync. **Re-issue the `testing` row's Private
   Integration token** (or repoint it) before this feature does anything useful
   in production. Verified live: it still returns
   `401 "The token is not authorized for this scope."`
2. **A per-client token scope audit is owed** — every sub-account that will use
   Refresh needs its conversations scope checked the same way.
3. **Facet counts ignore the last-activity filter** (§14.3). Fixing it means
   touching the six RPCs, which is the change §14.3 deliberately avoided.
4. **Only one page of the drawer's history is loaded** (200 messages, newest
   first). No pagination. Fine for every contact seen so far.
5. **The mixed-conversation caveat from §12.2 is still a 0-of-30 sample.** The
   code handles it correctly (an activity event never wins over a real message,
   and there is a test), but it has not been observed live.
6. **The first sync of a large location takes ~305 conversation calls plus one
   export per pushed contact.** Budgeted across worker ticks, but a location
   with tens of thousands of pushed contacts will span several cron minutes.
7. **Untested end to end in the browser.** The sync core, rules, filter and
   schema are covered by tests and live API probes; the React components were
   type-checked and linted but not click-tested.
8. **The live full-pipeline run against Internal was never completed.** Three
   attempts, each killed by the environment rather than by the code: one by a
   PostgREST schema-cache reload (my own concurrent DDL), one by exceeding its
   own 10-minute budget, and one by
   `Timed out acquiring connection from connection pool` on the Supabase
   project. The pieces were each verified live — endpoint shapes and cursor
   semantics, sweep-page latency, and the missing-scope 401 — and the whole
   pipeline is covered by tests against real Supabase with GHL stubbed, but a
   single green end-to-end run against live GHL data is still owed. The pool
   timeout is worth a look on its own; it is not caused by this feature (the
   sync opens no connections of its own, it goes through the shared
   supabase-js client) but it will bite the worker the same way.

   That third failure did surface a real bug, since fixed: per-contact failure
   reasons were logged as `[object Object]`, because supabase-js throws a bare
   `{message, code}` object that is not an `Error`. The push worker already
   carried an `errorMessage` helper written for this exact class of bug; it is
   now shared as `lib/errors.ts` and used by the sync. A third copy still sits
   in `app/api/internal/import-worker/route.ts`.

---

## 15. STATUS at hand-off (2026-09-30) — read this first

Branch `feat/ghl-last-activity`, 11 commits, **not pushed**. Working tree clean.

### 15.1 Per-task status

| # | Task | Status |
|---|---|---|
| 1 | Schema + apply via Supabase | **DONE** — applied, read back, rollback file current |
| 2 | Sync core `lib/ghl/sync-activity.ts` | **DONE** — 17 tests |
| 3 | Job wiring + auto-enqueue + endpoint | **DONE** — dispatch, auto-enqueue, refresh route |
| 4 | Incremental optimisation | **DONE** — hypothesis verified live, then improved (§14.2) |
| 5 | People-table column | **DONE** |
| 6 | Drawer | **DONE** |
| 7 | Filter | **DONE, but by a different route than the brief assumed** — see 15.2 |
| 8 | Refresh button | **DONE** |

### 15.2 Task 7: NO filter RPC WAS TOUCHED. Nothing to roll back.

The brief expected `people_matching_virtual_filters`, `person_filter_options`
and `person_push_status_counts` to be rewritten. **They were not. Their live
definitions are byte-identical to what they were before this branch.** No
`CREATE OR REPLACE FUNCTION` was ever executed.

Instead the filter resolves an id set directly off `platform_pushes` through
PostgREST (`resolveLastActivityIds` in `lib/data/ghl-activity.ts`) and
intersects it in app code inside `resolveRestrictedRows`
(`lib/data/people.ts`), which is exactly the mechanism the existing `pushJobId`
filter already uses. Reasons in §14.3. The id set is bounded by one client's
pushed population, not by `people`.

**What this costs:** filter-slip facet counts are not scoped by an active
last-activity filter (`pushJobId` has the same gap today). The results-header
row count IS correct. A fresh agent who wants facet scoping must take on the
six-RPC change the T25 notes warn about — start at
`lib/data/ticket-25-esp-filter.sql:23-31`, capture `pg_get_functiondef` first,
and benchmark the no-filter list call (baseline below) before and after.

### 15.3 Wired end to end vs. scaffolded

Everything is reachable from the UI: the column renders in
`components/people/people-table.tsx`, the drawer fetches
`/api/people/[id]/ghl-activity`, the filter writes the five `activity*` URL
params read by `parsePersonFilters`, and the Refresh button POSTs
`/api/people/refresh-ghl-activity`, which enqueues a `push_jobs` row with
`platform = 'ghl_activity'` that `app/api/internal/push-worker/route.ts`
dispatches. Nothing is scaffolded-but-unreachable.

**Not verified:** no browser click-test, and no completed end-to-end run
against live GHL (§14.5 item 8).

### 15.4 Database state — confirmed

Two migrations, both **purely additive**, statements re-read from
`supabase_migrations.schema_migrations` to confirm:

- `20260930164942 ghl_activity` — `CREATE TABLE IF NOT EXISTS ghl_messages`,
  `ghl_activity_sweeps`, `ghl_activity_queue`; `CREATE INDEX IF NOT EXISTS`
  ×4; `ALTER TABLE platform_pushes ADD COLUMN IF NOT EXISTS` ×4.
- `20260930171648 ghl_activity_sweep_cursor` —
  `ALTER TABLE ghl_activity_sweeps ADD COLUMN IF NOT EXISTS sweep_cursor_ms`.

**No pre-existing table, column, function, index or row was modified or
deleted.** Every statement is `IF NOT EXISTS` / `ADD COLUMN`. No DROP, no
ALTER of an existing column, no function replaced.

Test/probe data written during the build was removed: `ghl_messages`,
`ghl_activity_queue` and `ghl_activity_sweeps` are empty, and the 10
pre-existing `platform_pushes` rows are untouched with `last_activity_at`
still NULL.

### 15.5 Test status — honest

- **My three files: 50/50 passing** (`lib/ghl/activity-rules.test.ts`,
  `lib/ghl/sync-activity.test.ts`, `lib/data/last-activity-filter.test.ts`).
- **`lib/data/people.test.ts`: 37 failures, NOT verified against a baseline.**
  This is the one pre-existing suite my change touches (`getPeople` now also
  calls `getPeopleLastActivity`). Its own `beforeAll` hooks timed out at 10s
  during the run, which cascades. **A fresh agent must re-run it on a quiet
  database and compare against `main` before trusting this branch.** It is the
  single biggest open risk here.
- Confounder: another agent applied three unrelated migrations to this same
  live project while I was working (`import_key_lookup_rpcs`,
  `import_bulk_update_canonical_match`,
  `import_key_lookup_rpcs_aggregate_results`, 17:25-17:29). The database was
  under heavy concurrent load and `pg_stat_activity` showed 22 active
  connections. Those migrations touch import RPCs, not mine, but they make any
  timing or pass/fail signal from this window unreliable.
- Lint: clean on every file this branch touches; repo-wide count unchanged.

### 15.6 Baseline for whoever does the RPC work

No-filter People path, median of 5, measured on this project before any change:

- people list page 1 (50 rows, count exact): **1,004 ms**
- `person_filter_options` with no filters: **12,399 ms** (pre-existing; not
  caused by this work, worth its own ticket)

---

## 16. CREDENTIAL AUDIT + SESSION STATE (2026-10-01)

Read §15 first for per-task build status. This section adds what only existed in
the session chat: a full audit of every client's GHL credentials, plus two
unrelated data bugs found along the way.

### 16.1 All 17 clients audited — only ONE key is broken

Every client row with a `ghl_location_id` was probed read-only on four
endpoints. **16 of 17 can read messages today.**

| slug | GHL location name | contacts | conversations | export | pushed rows |
|---|---|---|---|---|---|
| internal | Internal (DO NOT SETUP) | ok | ok | ok | 0 |
| dma | Internal (DO NOT SETUP) | ok | ok | ok | 0 |
| **testing** | Internal (DO NOT SETUP) | ok | **401** | **401** | **10** |
| acceler8 | Acceler8 - Active | ok | ok | ok | 0 |
| bigleap | Big Leap - **Inactive** | ok | ok | ok | 0 |
| chamber_media | Chamber Media - Active | ok | ok | ok | 0 |
| chamber_media_secondary | Chamber Media Secondary - Active | ok | ok | ok | 0 |
| go_fish_digital | Go fish Digital - Active | ok | ok | ok | 0 |
| growth_lab | Growth Lab - Active | ok | ok | ok | 0 |
| kynship | Kynship - Active | ok | ok | ok | 0 |
| leadgenix | Leadgenix - Active | ok | ok | ok | 0 |
| redo | Redo - Active | ok | ok | ok | 0 |
| scaletopia | Scaletopia (A2P verified) - Active | ok | ok | ok | 0 |
| seedx | Seedx - **Inactive** | ok | ok | ok | 0 |
| strike_tax_advisory | **Leadgenix Secondary - Active** | ok | ok | ok | 0 |
| taktical_digital | Taktical Digital - Active | ok | ok | ok | 0 |
| wise_digital_partners | Wise Digital Partners - Active | ok | ok | ok | 0 |

**The blocker:** `testing` is the ONLY row with pushed contacts (10) and the ONLY
one that cannot read conversations. The feature is therefore inert until fixed.

Fix (no new GHL token needed — `internal` points at the same location and has a
working key; the value never passes through a transcript):

```sql
update clients
set ghl_api_key = (select ghl_api_key from clients where slug = 'internal')
where slug = 'testing';
```

NOT YET APPLIED as of this writing.

### 16.2 Two unrelated bugs found (NOT part of this feature)

1. **`strike_tax_advisory` points at the wrong GHL sub-account.** Its
   `ghl_location_id` resolves to a location GHL names **"Leadgenix Secondary"**,
   not Strike Tax Advisory. This affects the PUSH path, not just last activity —
   leads pushed to that client would land in another client's sub-account. It has
   0 pushes so far, so likely no damage yet. Verify the correct location ID
   before anyone pushes to it.
2. **`bigleap` and `seedx`** point at sub-accounts GHL marks **Inactive**.
   Reachable, but probably dormant. Worth confirming they are still wanted.

### 16.3 A non-bug, already checked

The audit flagged that `GET /conversations/messages/export` returns 422
("limit must not be less than 10") for any `limit < 10`. **The built code uses
`MESSAGE_EXPORT_LIMIT = 200`** (`lib/ghl/conversations.ts:27`), so this does not
apply. Do not "fix" it.

### 16.4 What a fresh agent should do FIRST

Do not start by reading all 716 lines of this file. Order of operations:

1. Read §15 (per-task status), then §16 (this section). §11-13 are settled
   research — read only if you need to justify the rule.
2. Apply the SQL in 16.1.
3. **Run ONE real sync against the 10 pushed contacts on `testing` and show the
   data.** Nothing in this build has ever run end to end — three attempts died to
   the environment. This single step validates or breaks the entire feature and
   should happen before any new work.
4. Only then take on new direction/changes.

### 16.5 Standing warnings for any agent touching this

- **Do NOT run the full `npm test` suite.** The user states it is unreliable.
  `lib/data/people.test.ts` showed 37 failures that were never baselined against
  `main` (another agent was applying unrelated migrations to the live DB at the
  same time, 22 active connections — all timing signal from that window is
  junk). Run only targeted test files.
- **Do NOT rewrite the filter RPCs.** The build deliberately avoided this by
  resolving the filter as an id set off `platform_pushes`
  (`resolveLastActivityIds`). `lib/data/ticket-25-esp-filter.sql:23-31` records a
  ~60x slowdown and a timeout from the last attempt. `people_matching_virtual_filters`,
  `person_filter_options` and `person_push_status_counts` are currently
  byte-identical to `main`. Keep them that way.
- **Never print a GHL token.** Read credentials inside a script, never via a SQL
  select into a transcript.
- Branch `feat/ghl-last-activity`, 12 commits, clean tree, **not pushed**.
- Two migrations applied to the live project (`ghl_activity`,
  `ghl_activity_sweep_cursor`), both purely additive. Rollback:
  `lib/data/ghl-activity-rollback.sql`.

### 16.6 Known gaps carried forward

- No live end-to-end run. No browser click-test of drawer, filter or refresh.
- Filter facet counts are not scoped by the filter (row counts ARE correct).
  Same pre-existing behaviour as the `pushJobId` filter.
- `body` truncation untested against email (Internal has zero email traffic).
- Old leaked Private Integration token from the original research session still
  needs revoking (§9).
- 10 `@rblaw.net` test contacts still exist in GHL + `platform_pushes`. Keep as
  fixtures or delete — undecided.
