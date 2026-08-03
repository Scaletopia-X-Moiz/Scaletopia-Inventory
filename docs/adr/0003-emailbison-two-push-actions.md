# EmailBison push is two independent actions, not one combined button

## Context

GHL push is a single button: "Push to GHL" creates-or-updates the contact and
appends the structured tag in one flow. The ticket's naive read of EmailBison
("Push to EmailBison" placed on Companies + People, same pattern as GHL) would
suggest the same shape — one button, one flow.

But Clay, the tool this feature explicitly replicates, exposes EmailBison as
**two separate enrichments**: "Create or Update Lead" (adds/updates the lead in
the workspace) and "Import Lead(s) to Campaign" (attaches an existing lead to a
campaign). These are wired independently in a Clay table — a user can run one
without the other, e.g. stage leads in the workspace now and campaign them
later once a sequence is ready.

## Decision

EmailBison push is **two independent actions**, each its own button, placed on
both the Companies and People tables (Companies resolves to the linked People,
per the `Companies-table push` glossary entry):

- **"Add to EmailBison"** — create-or-update the lead (`POST
  /api/leads/create-or-update/multiple`, upsert by email). No campaign
  involved.
- **"Add to Campaign"** — attach to a campaign selected from a live-fetched
  `GET /api/campaigns` dropdown. If the person has no existing EmailBison
  `platform_pushes` row yet, this action **silently runs "Add to EmailBison"
  first** to obtain a `lead_id`, then calls `attach-leads` — the user never
  needs to run the two buttons in a required order.

This is a deliberate divergence from GHL's one-button shape, not an
inconsistency: EmailBison's own object model (workspace membership vs campaign
membership are separate lifecycle states) doesn't collapse into one action the
way a GHL contact-plus-tag does.

## Consequences

- More UI surface than GHL (two buttons × two tables instead of one × two),
  and two `platform_pushes`-shaped outcomes to show in the push summary instead
  of one.
- Campaign attachment is **async on EmailBison's side** (up to ~5 minutes to
  sync) — the "Add to Campaign" summary should say the leads were queued, not
  imply immediate campaign membership.
- No default quality filter is applied before either action (unlike GHL's
  phone_type default) — both actions push exactly the current filtered/
  selected People as-is; email-quality filtering, if wanted, is the user's job
  via the existing People-table filters.
