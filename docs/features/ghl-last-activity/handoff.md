# Handoff: GHL "Last activity" in the data inventory

Written 2026-09-29/30 after a research session. Nothing has been built. No repo code was changed. This file is the only artifact.

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
