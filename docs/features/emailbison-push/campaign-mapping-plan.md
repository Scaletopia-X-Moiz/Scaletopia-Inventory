# EmailBison Campaign — Add Column Mapping

**Source:** Slackline feedback (4 Aug retest). They want the `/import`-style column-mapping
system on the **"Add to EmailBison Campaign"** flow — not just on "Add to EmailBison".

**Decision (team, 2026-08-06):** Add the standard-field + custom-variable mapping to the
**Campaign** flow.

---

## Why it's missing today (the reason, for context)

The two buttons hit different EmailBison object models (ADR 0003):

| Action | API call | Body | Needs mapping? |
|---|---|---|---|
| **Add to EmailBison** | `POST /api/leads/create-or-update/multiple` | full per-lead field payload | Yes — has mapping table |
| **Add to EmailBison Campaign** | `POST /api/campaigns/{id}/leads/attach-leads` | just lead IDs + `parallel` | No — nothing to map |

Campaign attach only carries **lead IDs**, so there's no field payload to map. BUT the
campaign flow *silently* runs the workspace upsert first for anyone missing a lead ID
(`lib/emailbison/push-to-emailbison.ts:702`) — and today that fallback uses the **default
include-all mapping** because the campaign dialog never collects one. That's the gap
Slackline is hitting: campaign-created leads aren't mapped the way the user wants.

---

## What to change

1. **UI** — `components/people/push-to-emailbison-campaign-button.tsx` and
   `components/companies/push-to-emailbison-campaign-button.tsx`:
   add the `StandardFieldMappingTable` (`components/emailbison/standard-field-mapping-table.tsx`)
   + custom-variable editor to the campaign options step, reusing the exact code from the
   workspace buttons (`push-to-emailbison-button.tsx`).

2. **Default mapping** — reuse `resolveDefaultFieldMapping` + saved-mapping override
   (`lib/push/resolve-default-field-mapping.ts`, `lib/data/push-field-mappings-client.ts`).
   Decide the saved-mapping key: reuse `emailbison_people` / share with workspace, or a new
   `emailbison_campaign_people` key. **Open question — see below.**

3. **Payload** — campaign confirm currently POSTs `{ entity, action: "campaign", clientId,
   campaignId, parallel }` with **no** `standardFieldMapping` / `customVariables`. Add both
   so the silent workspace-upsert prerequisite uses the user's mapping.

4. **Server** — `runEmailBisonAddToCampaign` (`push-to-emailbison.ts:628`) already routes
   through the workspace upsert for missing lead IDs; thread `standardFieldMapping` /
   `customVariables` into that path (`push-to-emailbison.ts:702-732`).

5. **Dispatch** — `app/api/emailbison/push/route.ts` (action `"campaign"`): accept and
   forward the mapping fields.

---

## Open questions

- **Shared vs separate saved mapping?** Should the campaign flow reuse the same saved
  mapping as "Add to EmailBison", or keep its own? (Simplest: share it.)
- **What about leads that already exist?** Attach-only leads (already have a lead ID) skip
  the upsert entirely, so a mapping won't re-write their fields. Confirm Slackline is okay
  with mapping applying only to newly-created leads, or whether they expect an upsert on
  every campaign push.

---

## Reference (existing "map columns" implementation)

- Mapping table: `components/emailbison/standard-field-mapping-table.tsx`
- Workspace button (copy from here): `components/people/push-to-emailbison-button.tsx`
- Default resolver: `lib/push/resolve-default-field-mapping.ts`
- Saved mappings: `lib/data/push-field-mappings-client.ts` / `.sql`
- Payload builder: `lib/emailbison/lead-payload.ts:82` (`applyIncludeSkip`), `:93` (`resolveCompanyName`)
- ADR: `docs/adr/0003-emailbison-two-push-actions.md`
