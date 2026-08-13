# GHL push mapping — research for "perfect" field/campaign mapping

Research only — no code changed. Written 2026-08-12 in response to the feedback:
> "The push to GHL is giving a very minimal include/exclude thing. I want proper mapping
> like when we use the /import feature. Also, the campaign mapping should have custom
> variable mapping."

**Headline finding up front**: the "very minimal include/exclude thing" description is
**stale**. Ticket #142 (commit `9d18d2a`, the most recent commit on `main` before this
session — "feat(ghl): field-mapping parity with EmailBison (literals + any-source)")
already replaced a plain checkbox include/exclude UI with a real per-custom-field
column/literal mapping table, auto-mapping, and per-client persistence. The feedback may
predate that deploy, or the user hasn't reopened the dialog since. That said, real gaps
remain relative to both `/import` and EmailBison — detailed below — and the **campaign
custom-variable mapping** half of the complaint is entirely accurate: it's a documented,
un-implemented gap (see `EMAILBISON-CAMPAIGN-MAPPING-PLAN.md`, untracked in git) that
doesn't even apply to GHL, because GHL has no campaign/workflow push action at all today.

---

## Current state

### What "Push to GHL" does today

Single button, single push action (`docs/adr/0003-emailbison-two-push-actions.md:9-12`
contrasts this explicitly with EmailBison's two actions) — create-or-update a GHL contact
plus an optional tag. Three-step dialog in
`components/people/push-to-ghl-button.tsx`: **picker** (choose client) → **mapping** →
**confirm** (eligibility preview + tag).

The mapping step (`components/people/push-to-ghl-button.tsx:493-648`) has two parts:

1. **Standard fields table** (`GhlStandardFieldMapping`,
   `lib/ghl/types.ts:73-81`) — one row per fixed GHL contact field
   (firstName/lastName/email/phone/city/country), each an `include`/`skip` `<select>`
   (`push-to-ghl-button.tsx:548-567`), plus a 3-way `companyName` row
   (`brand_name` / `company_name` / `skip`, `push-to-ghl-button.tsx:529-547`). This is
   the literal "include/exclude" the feedback names — and for these six fixed fields,
   that actually is the full extent of what's configurable: **there is no way to choose
   a different *source* column for firstName/email/phone/etc.** (unlike `/import`, where
   any CSV column can be mapped to any target field). Only `companyName` gets a
   3-way source choice; everything else is include-or-skip against one hardcoded
   `GhlPushRecord` field (`lib/ghl/contact-payload.ts:60-87`).

2. **Custom-fields table** (`push-to-ghl-button.tsx:568-620`) — one row **per GHL custom
   field that exists on the client's location** (fetched live via
   `GET /api/clients/[id]/ghl-custom-fields` →
   `getGhlCustomFields`, `lib/ghl/custom-fields.ts:58-71`), each with a source `<select>`:
   `— ignore —` / `Column` / `Literal`. Column rows get a second `<select>` of bindable
   People-table fields (`BINDABLE_RECORD_COLUMNS`,
   `push-to-ghl-button.tsx:52-64`, extended with active virtual columns and discovered
   enrichment fields, `:387-398`); literal rows get a free-text input
   (`push-to-ghl-button.tsx:607-614`). This part **is** genuinely `/import`-shaped
   column-to-field mapping — see the `/import` comparison below for the remaining UX gap
   (confidence dot present, but no sample-value preview).

Data model (`lib/ghl/types.ts:44-64`):

```ts
export interface GhlFieldMapping {
  ghlFieldId: string;           // target: GhlCustomField.id
  source: "column" | "literal";
  columnKey?: string;           // required when source === "column"
  value?: string;               // required when source === "literal"
}
```

Auto-mapping (`lib/push/resolve-default-field-mapping.ts:88-107`) fuzzy-matches every
GHL custom field's *name* against the union of active virtual columns and
`GHL_KNOWN_RECORD_FIELDS` (`lib/ghl/contact-payload.ts:17-29`) via the same
`fuzzyMatchColumn` `/import` uses (`lib/import/normalize.ts`), scored 0–1 and rendered as
a confidence dot (`ScoreIndicator`, `push-to-ghl-button.tsx:66-71`) — identical component
to `/import`'s own `ScoreIndicator` (`app/import/page.tsx:549-554`).

Persistence: last-used mapping is saved per `(client_id, "ghl")` in `push_field_mappings`
(generic jsonb table, see below) on every confirm
(`push-to-ghl-button.tsx:343-349`) and pre-loaded on the next open
(`:277-295`), overriding the pure auto-mapping default — same "remember last mapping"
pattern `/import`'s `import_provider_mappings` gives per `sourceKey`.

Server-side: `app/api/people/push-to-ghl/route.ts` accepts `fieldMapping` +
`standardFieldMapping` in the POST body, validates/normalizes them
(`normalizeGhlFieldMapping`, `lib/ghl/field-mapping.ts:45-53`, upgrades legacy
pre-#142 shapes), and stores them opaquely on the `push_jobs.options` row — the actual
push runs as a background job (`lib/data/push-jobs.ts`), picked up by a worker that calls
`runPeopleGhlPush` (`lib/ghl/push-to-ghl.ts:211`), which threads the mapping into
`buildGhlCustomFields`/`buildGhlContactPayload` (`lib/ghl/contact-payload.ts:118-136`,
`:60-87`) per candidate.

**Custom fields are referenced by GHL's `id`** (not `fieldKey`) — confirmed working
against live production in `docs/features/ghl-push/internal-client-verification.md`
sessions 3–5, including the `customField`→`customFields` (singular→plural) wire-shape bug
found and fixed there (session 3, `docs/features/ghl-push/internal-client-verification.md:103-120`).

### What's *not* present today

- **No campaign/workflow concept for GHL at all.** `createPushJob` for GHL always sends
  `campaignId: null` (`app/api/people/push-to-ghl/route.ts:96`); there is no
  `push-to-ghl-campaign-button.tsx`, no `GET /api/clients/[id]/ghl-campaigns` or
  `ghl-workflows` route, no `lib/ghl/campaigns.ts`. GHL push is the tag-and-contact model
  only.
- **No sample-value column** in the GHL mapping table — `/import`'s `MappingTable` shows
  `sampleRow?.[csvHeader]` next to each row (`app/import/page.tsx:585-590`); the GHL
  mapping table has no equivalent, so a user can't sanity-check "does this virtual column
  actually have data" before mapping it.
- **No arbitrary-source mapping for the six standard fields** — see point 1 above. This
  is the sharpest remaining gap vs. `/import`'s model, where literally *every* target
  field (standard or custom) is a row with a free choice of source.

---

## The gap, precisely

| | `/import` | GHL push (today) | EmailBison workspace push (today) |
|---|---|---|---|
| Standard-field source choice | Any CSV column → any target field, per row | Fixed record field, include/skip only (companyName gets 3-way) | Same as GHL (include/skip, companyName 3-way) — `EmailBisonStandardFieldMapping` |
| Custom-field mapping | N/A (single flat field namespace) | Per-GHL-custom-field row, column **or literal**, auto-matched + confidence dot | Manually-added named rows (not tied to a pre-existing field list), literal **or column** |
| Sample data shown per row | Yes | No | No |
| Persisted per destination | Yes (`import_provider_mappings`, keyed by `sourceKey`) | Yes (`push_field_mappings`, keyed by `(client_id, "ghl")`) | Yes (`push_field_mappings`, keyed by `(client_id, "emailbison_people")`) |
| Campaign/destination selection | N/A | **None** | Separate "Add to Campaign" button, campaign picked from live `GET /api/campaigns` |
| Custom variable/field mapping on campaign action | N/A | N/A (no campaign action) | **Not implemented** — campaign attach sends no mapping at all (see below) |

So concretely, three distinct gaps map onto the user's one sentence:

1. **GHL's six standard fields are include/skip-only, not full re-source-able** — this is
   the accurate part of "very minimal include/exclude thing," scoped correctly to just
   those six fields, not the whole mapping step (custom fields already have real mapping).
2. **GHL has no campaign/destination concept at all** — nothing to map custom variables
   *into* on a per-campaign basis, because there's no campaign action.
3. **EmailBison's own campaign action has no mapping** — `EMAILBISON-CAMPAIGN-MAPPING-PLAN.md`
   (untracked, i.e. not yet actioned) documents this exact gap already: "Add to
   EmailBison Campaign" POSTs `{entity, action: "campaign", clientId, campaignId,
   parallel}` with **no** `standardFieldMapping`/`customVariables`
   (`components/people/push-to-emailbison-campaign-button.tsx` — confirmed via `grep`,
   zero matches for `standardFieldMapping`/`customVariables`/`StandardFieldMappingTable`),
   even though the silent workspace-upsert fallback it runs for un-pushed people
   (`lib/emailbison/push-to-emailbison.ts:628-732`) *could* use one.

The user's "campaign mapping should have custom variable mapping" is almost certainly
about **#3** (EmailBison's campaign button), not a GHL campaign feature that doesn't
exist — GHL's nearest equivalent (Workflows, see API section) isn't wired into this app
at all yet, so "GHL campaign mapping" isn't a gap so much as a whole unbuilt feature.

---

## Reference: `/import` mapping UX

`app/import/page.tsx`, five-step wizard (Upload → Map Columns → Metadata → Summary →
Progress → Report):

- **Provider presets** (`lib/import/providers.ts`, `BUILTIN_PROVIDERS`) carry a
  `columnMap` that pre-fills the mapping for known CSV shapes (Apollo, Clay exports,
  etc.); a custom provider can be added inline (`app/import/page.tsx:287-325`) and its
  mapping is persisted for reuse.
- **`MappingTable`** (`app/import/page.tsx:556-609`) — one row **per CSV column** (not
  per target field): confidence dot, the column's own name, a **sample value from the
  first parsed row**, and a `<select>` of every valid target field for the chosen table
  (`COMPANIES_FIELDS`/`PEOPLE_FIELDS`, `lib/import/providers.ts`) plus `— ignore —`.
- **Auto-mapping** (`autoMapColumns`, `app/import/page.tsx:147-193`) uses
  `fuzzyMatchColumn` per header, then resolves many-to-one collisions by keeping only the
  strongest header per target field (demoting the rest to ignore) — a step GHL's
  resolver doesn't need since it only auto-maps into a locked one-to-one set (GHL custom
  field ids), but demonstrates the more general "many source columns, few target slots"
  problem `/import` had to solve.
- **Company-sync side channel**: a checkbox unlocks a *second* independent
  `MappingTable` for embedded company columns within a people CSV
  (`app/import/page.tsx:687-717`) — two full field-set mappings running in parallel in
  one wizard step.
- **Persistence**: `POST /api/import/mappings` saves `{sourceKey, columnMap,
  targetTable}` (`app/import/page.tsx:663-676`); reloaded and merged into the auto-mapped
  defaults on the next visit for the same `sourceKey`
  (`app/import/page.tsx:634-649`) — the same "auto-map, then let a saved mapping
  override" two-layer pattern `push-field-mappings-client.ts` gives GHL/EmailBison.
- **Preflight** (`app/api/import/preflight/route.ts`) gives a dry-run insert/update/dedupe
  count *before* commit, something neither push flow currently has beyond the coarse
  eligible/skipped GHL preview.

**The UX target the user is naming**: a single table, one row per *field the platform can
receive*, sample data visible, free choice of source per row, auto-matched with a
confidence signal, remembered per destination. GHL's custom-fields table already matches
this shape closely; its standard-fields table and EmailBison's campaign flow don't.

---

## Reference: EmailBison mapping model

Two independent push actions (ADR 0003, `docs/adr/0003-emailbison-two-push-actions.md`):

- **"Add to EmailBison"** (workspace upsert, `POST /api/leads/create-or-update/multiple`)
  — has full mapping: `StandardFieldMappingTable`
  (`components/emailbison/standard-field-mapping-table.tsx`, same include/skip + 3-way
  companyName shape as GHL) plus a **free-form custom-variable row editor**
  (`components/people/push-to-emailbison-button.tsx:491-584`) — `+ Add variable` button,
  each row: name (free text, not tied to a pre-existing list), source
  literal/column, value or column `<select>`. A read-only reference panel shows the
  workspace's *existing* variable names for typo-avoidance
  (`:586-613`) but doesn't constrain what you type — this is EmailBison's actual API
  contract: variables are name/value pairs with no server-side id, unlike GHL's
  id-addressed custom fields (`docs/features/emailbison-push/README.md:25`: "pass the
  variable name as-is, no ID lookup needed (unlike GHL)").
- **"Add to Campaign"** (`POST /api/campaigns/{id}/leads/attach-leads`) — campaign picked
  from a live `GET /api/campaigns` dropdown
  (`app/api/clients/[id]/emailbison-campaigns/route.ts` → `lib/emailbison/campaigns.ts`).
  **No mapping UI at all today** — this is the gap
  `EMAILBISON-CAMPAIGN-MAPPING-PLAN.md` describes and is not yet implemented (confirmed:
  `git status` shows the plan doc untracked; `grep` for
  `standardFieldMapping|customVariables|StandardFieldMappingTable` in
  `push-to-emailbison-campaign-button.tsx` returns nothing). It matters because any
  candidate with no prior `platform_pushes` row silently runs the workspace-upsert first
  (`lib/emailbison/push-to-emailbison.ts`, `runEmailBisonAddToCampaign`, calls
  `upsertCandidatesToWorkspace` for `needsUpsert` — confirmed at
  `lib/emailbison/push-to-emailbison.ts` around the `runEmailBisonAddToCampaign`
  function, ~line 628+), and that upsert **currently always uses the default
  include-all mapping** since the campaign dialog collects none.

Data model (`lib/emailbison/types.ts:45-59, 67-75`):

```ts
export interface EmailBisonCustomVariableEntry {
  name: string;         // free-typed, no server-side id
  value: string;         // literal value
  columnKey?: string;    // if set, resolved per-candidate instead of `value`
}
export interface EmailBisonStandardFieldMapping {
  companyName: "brand_name" | "company_name" | "skip";
  firstName | lastName | email | phone | title | website: "include" | "skip";
}
```

Resolution: `resolveCustomVariables` (`lib/emailbison/lead-payload.ts:70-91`) — same
`resolveMappedValue` shared primitive GHL uses, different stringify strategy (JSON-encode
arrays vs. GHL's `", "`-join, deliberately kept divergent — see the
`stringifyCustomFieldValue`/`stringifyCustomValue` comments in both files warning against
convergence).

---

## Shared push infra — is it generic, and can GHL reuse it?

**Yes, already shared, already platform-agnostic where it matters:**

- **`lib/push/resolve-mapped-value.ts`** — the literal-vs-column resolution primitive.
  Explicitly generic (`MappedEntry` has no platform fields); both GHL's
  `buildGhlCustomFields` and EmailBison's `resolveCustomVariables` close over their own
  record-lookup + stringify functions and call into it. A hypothetical GHL-workflow
  custom-field mapping would reuse this directly.
- **`lib/push/resolve-default-field-mapping.ts`** — one function, overloaded per
  `platform: "ghl" | "emailbison"`, sharing the `resolveDefaultCompanyNameSource` logic
  and `fuzzyMatchColumn` call. Adding a third platform (e.g. a GHL-workflow-scoped custom
  variable set) means adding another overload branch, not new infrastructure.
- **`lib/data/push-field-mappings.sql` / `push-field-mappings-client.ts`** — fully
  generic: `(client_id, platform, mapping jsonb)` with `platform` as a free-text
  discriminator already carrying three distinct values (`"ghl"`,
  `"emailbison_people"`, `"emailbison_companies"`) and documented as deliberately
  opaque-per-caller (`push-field-mappings.sql:9-14`: "mapping is stored opaque (jsonb) —
  its shape is whatever that platform's push button currently sends"). A fourth platform
  key (e.g. `"ghl_workflow"`) is a zero-migration addition.
- **`ScoreIndicator`** — currently **duplicated** verbatim in
  `app/import/page.tsx:549-554` and `components/people/push-to-ghl-button.tsx:66-71` (and
  a third near-identical copy doesn't exist for EmailBison only because its custom-variable
  rows aren't matched against a pre-existing field list). Worth extracting to a shared
  component if any new mapping UI is added — not currently blocking anything, but a clean
  "reuse assessment" flag.

**What's platform-specific and must stay that way** (called out explicitly in code
comments, not just my inference):

- **Custom-field addressing**: GHL fields are addressed by server-assigned `id`
  (`ghlFieldId`); EmailBison variables are addressed by free-typed `name` — no id lookup.
  This is a real API-contract difference, not an accidental divergence
  (`docs/features/emailbison-push/README.md:25`).
- **Array stringification**: GHL joins with `", "`, EmailBison JSON-encodes — both files
  carry `CRITICAL: keep this ... must not converge` comments (`lib/ghl/contact-payload.ts:96-99`,
  implied symmetric comment in `lead-payload.ts`). Any shared-mapping refactor must keep
  `stringify` as an injected parameter, not hoist it.
- **Standard field sets differ**: GHL has city/country/niche/employeeCount/source: no title/website;
  EmailBison has title/website: no city/country. `GHL_KNOWN_RECORD_FIELDS` and
  `KNOWN_RECORD_FIELDS` (EmailBison) are separate maps by design.
- **`BINDABLE_RECORD_COLUMNS`** is duplicated per button
  (`push-to-ghl-button.tsx:52-64`, `push-to-emailbison-button.tsx:41-49`) rather than
  shared, because the two platforms' fields genuinely differ, not out of neglect.

**Bottom line**: the resolver/persistence layer needs no new abstraction to support
either "make GHL standard fields fully re-sourceable" or "add GHL workflow attach +
mapping" — it's already shaped for N platforms. The work is in the UI components and the
GHL API/orchestration layer, not the shared `lib/push/*` core.

---

## GHL API reality

Sources: HighLevel's own developer portal
([marketplace.gohighlevel.com/docs](https://marketplace.gohighlevel.com/docs/)) and this
repo's own live-API verification log
(`docs/features/ghl-push/internal-client-verification.md`), which is the higher-trust
source here since it's actual confirmed wire behavior against a real location, not just
docs prose (GHL's docs pages did not reliably return readable content via fetch during
this research — several came back empty; falling back to WebSearch summaries plus this
repo's own verified behavior).

- **Contact create/update**: `POST /contacts/` (confirmed in this repo,
  `lib/ghl/client.ts`, exercised live per the verification log). Custom fields are sent
  on a `customFields` (plural) array of `{id, value}` pairs — confirmed against real GHL
  responses across five verification sessions
  (`docs/features/ghl-push/internal-client-verification.md`, the `customField` →
  `customFields` bug-fix in session 3). **Not** `{key, value}` — GHL's v2 custom-fields
  API does support a `fieldKey` alongside `id` for readability
  (`GET /locations/{locationId}/customFields` → `GhlCustomField.fieldKey`, already
  captured in `lib/ghl/custom-fields.ts:4-9`), but the contact-write payload this repo
  uses is id-addressed, matching the pattern EmailBison explicitly differs from.
- **Custom fields are location-scoped**: `GET /locations/{locationId}/customFields`
  (`lib/ghl/custom-fields.ts:37-53`) — this repo already has full read coverage of the
  field catalog (id, name, fieldKey, dataType) needed for a richer mapping UI; nothing
  new to fetch from GHL to build "map anything to anything."
- **Campaigns vs. Workflows are genuinely two different GHL objects**, and it matters for
  scoping any GHL-side campaign feature:
  - **Workflows** — GHL's automation/nurture-sequence primitive, closest functional
    analog to EmailBison's "campaign" (multi-step sequences a contact runs through).
    `POST /contacts/{contactId}/workflow/{workflowId}` adds a contact to one
    ([marketplace.gohighlevel.com/docs/ghl/contacts/add-contact-to-workflow](https://marketplace.gohighlevel.com/docs/ghl/contacts/add-contact-to-workflow/)).
    This is the endpoint a "Push to GHL Workflow" feature would use.
  - **Campaigns** (legacy GHL term, one-off broadcast blasts, distinct from Workflows in
    GHL's own UI nav) — the v1 "Workflow Campaign" endpoints
    (`Get/List Workflow Campaigns`) are flagged deprecated in favor of the Workflows
    API; GHL's own product direction has moved this concept mostly onto Workflows.
    Building a GHL analog to EmailBison's "Add to Campaign" should almost certainly
    target **Workflows**, not GHL's legacy Campaigns object.
  - No custom-field/custom-variable payload rides along with either endpoint — adding a
    contact to a workflow is contact-id-only, structurally identical to EmailBison's
    `attach-leads` (lead-id-only). Any "custom variable" the workflow should see would
    have to be written onto the contact's custom fields **first** (i.e. the existing
    contact-create/update mapping step), then the contact added to the workflow — the
    same two-phase shape ADR 0003 already established for EmailBison
    (silently upsert-then-attach).
- **Tags**: sent inline on contact create (`tags: string[]`), no separate endpoint
  needed — already fully implemented, not part of this gap.

Sources:
- [Add Contact to Workflow | HighLevel API](https://marketplace.gohighlevel.com/docs/ghl/contacts/add-contact-to-workflow/)
- [HighLevel API Documentation Portal](https://marketplace.gohighlevel.com/docs/)
- [Get Workflow Campaign by ID | HighLevel API](https://marketplace.gohighlevel.com/docs/2023-02-21/ghl/emails/get-workflow-campaign-v-2/) (deprecated v1 concept)
- `docs/features/ghl-push/internal-client-verification.md` (this repo's own live-API verification, sessions 1–5)

---

## Proposed plan

Three independent workstreams — do not block one on another; they touch different
buttons/routes.

### Phase 1 — GHL standard-field full re-sourcing (closes the literal "include/exclude" complaint)

Make the six fixed GHL fields (firstName/lastName/email/phone/city/country) choosable
from *any* bindable column, not just include/skip — i.e. give GHL's standard-fields table
the same row shape as its own custom-fields table (source: ignore/column/literal, with a
column picker), rather than a plain toggle.

- **Data model**: extend `GhlStandardFieldMapping` (`lib/ghl/types.ts:73-81`) — replace
  each `"include" | "skip"` with `{source: "column" | "literal" | "skip"; columnKey?:
  string; value?: string}` (companyName keeps its existing 3-way as a special case, or
  folds into the same shape with `columnKey` defaulting to `"companyName"`/`"brandName"`).
  This is a breaking shape change for saved `push_field_mappings` rows and in-flight
  `push_jobs.options` — needs a `normalizeGhlStandardFieldMapping` upgrade path exactly
  like `normalizeGhlFieldMapping` already does for custom fields (`lib/ghl/field-mapping.ts:32-53`).
- **Resolution**: `buildGhlContactPayload` (`lib/ghl/contact-payload.ts:60-87`) already
  has `resolveGhlColumnValue` for exactly this lookup (built for custom fields) — reuse
  it for standard fields too instead of the current hardcoded `record.firstName` etc.
- **UI**: collapse the two tables in `push-to-ghl-button.tsx` into one, or keep two
  tables but give the standard-fields one the same source `<select>` pattern as the
  custom-fields one.
- **Effort**: medium (1–2 days) — mostly plumbing an existing pattern into a second
  table; the hard parts (fuzzy-match, persistence, resolve-mapped-value) already exist.
- **Open question for the user**: is re-sourcing firstName/lastName/email/phone actually
  wanted, or was the complaint really just about custom fields (which already work)? If
  the latter, skip this phase — cheaper to confirm than to build speculatively.

### Phase 2 — EmailBison "Add to Campaign" mapping (closes the literal "campaign mapping ... custom variable mapping" complaint)

Execute `EMAILBISON-CAMPAIGN-MAPPING-PLAN.md` as already scoped — it's a complete,
already-written plan, not something to re-derive:

1. Add `StandardFieldMappingTable` + the custom-variable row editor to
   `components/people/push-to-emailbison-campaign-button.tsx` and
   `components/companies/push-to-emailbison-campaign-button.tsx`, copied from
   `push-to-emailbison-button.tsx`.
2. Thread `standardFieldMapping`/`customVariables` through the campaign POST body,
   `app/api/emailbison/push/route.ts` (action `"campaign"`), and
   `runEmailBisonAddToCampaign`'s upsert-fallback call
   (`lib/emailbison/push-to-emailbison.ts`, ~line 702-732).
3. Reuse `resolveDefaultFieldMapping`/`push-field-mappings-client.ts` for defaults +
   persistence — **decide the saved-mapping key** (plan's own open question: share
   `emailbison_people`, or a new `emailbison_campaign_people`). Recommendation: share —
   a client's field mapping to EmailBison shouldn't differ by which button triggered it,
   and a separate key doubles the "which mapping is stale" surface for no clear benefit.
- **Effort**: small (~0.5–1 day) — the plan doc's own estimate implicitly matches this;
  it's copy-and-thread, not new design.
- **Open question for the user** (from the plan doc, still unresolved): should a mapping
  apply retroactively to already-existing leads being attached (no upsert runs for
  them today), or only to newly-created ones? Recommend: newly-created only, ship that,
  revisit if someone actually asks for a forced re-upsert-on-attach.

### Phase 3 — GHL Workflow push action (net-new feature, not a fix — only pursue if explicitly wanted)

Nothing today gives GHL a campaign/sequence equivalent. If the user wants literal parity
with EmailBison's two-action model:

1. **New lib**: `lib/ghl/workflows.ts` — `GET` a client's workflows (need to confirm the
   exact list-workflows v2 endpoint; not yet verified live in this repo, unlike custom
   fields/contacts), cached per-client like `lib/ghl/custom-fields.ts`/`lib/emailbison/campaigns.ts`.
2. **New route**: `GET /api/clients/[id]/ghl-workflows`.
3. **New action**: `POST /contacts/{contactId}/workflow/{workflowId}` per pushed contact,
   after the existing create-or-update step (mirrors EmailBison's
   upsert-then-attach two-phase shape from ADR 0003) — no new mapping primitive needed
   here, since workflow-add carries no field payload; the mapping that matters is
   whatever already ran in the contact create/update step (Phase 1, if built).
4. **New UI**: `push-to-ghl-workflow-button.tsx`, following
   `push-to-emailbison-campaign-button.tsx`'s shape (picker → workflow dropdown →
   confirm), reusing `push_field_mappings` under a new `"ghl_workflow"` (or shared
   `"ghl"`) key if any pre-attach mapping step is offered.
5. **ADR**: worth a short addendum to `docs/adr/0003-emailbison-two-push-actions.md` or a
   new ADR, since this changes GHL from a documented one-action model to two.
- **Effort**: medium-large (3–5 days) — genuinely new surface (route, lib, live-API
  verification session like the GHL contact push got), not a mapping-model change.
- **Open questions for the user**:
  - Is this actually wanted, or did "campaign mapping" in the original feedback mean
    EmailBison's campaign button only (Phase 2)? Worth confirming before Phase 3 — it's
    the only phase here that's a new feature rather than closing a stated gap.
  - GHL Workflows vs. legacy Campaigns — confirm Workflows is the right target (this
    report recommends it; legacy Campaign endpoints are flagged deprecated by GHL).
  - Does a contact need to already exist as a GHL contact before workflow-add, or can
    GHL add-by-new-contact-payload in one call? (Needs a live-API check, same rigor as
    `docs/features/ghl-push/internal-client-verification.md` gave the original push.)

### Suggested order

Phase 2 first (cheapest, plan already written, closes the most literal reading of the
feedback's second sentence) → confirm with the user whether Phase 1 and/or Phase 3 are
actually wanted before building either, since both are more speculative reads of a
one-sentence complaint against a codebase that (for custom fields at least) already does
most of what `/import` does.
