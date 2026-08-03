# EmailBison API — research notes (2026-07-31, updated 2026-07-31)

Gathered via web search against docs.emailbison.com, emailbison.com/developers,
university.clay.com (Clay's own EmailBison integration page), and the source of
`bcharleson/emailbison-cli` (a public, MIT-licensed CLI/MCP wrapper over the full
EmailBison API — its `src/commands/**/*.ts` files declare each endpoint's exact
HTTP method + path via a typed `CommandDefinition`, which is the most reliable
source found since it's generated from the real API surface, not prose docs).
`docs/tickets-info.pdf` section 2 only says "Saqlain will walk you through how
those work on the call" and gives no endpoint detail. Still not verified
against a live workspace/token — the CLI's endpoint shapes should be right, but
response bodies and edge-case status codes should get a final check against a
real token before shipping.

## Auth

- `Authorization: Bearer {token}` — tokens created in EmailBison Settings → Developer API →
  New API Token. Docs recommend `api-user` keys for integrations over personal tokens.
- **Base URL is workspace-specific**, e.g. `https://dedi.emailbison.com` for one workspace.
  This means `clients.emailbison_workspace_id` (per `tickets-info.pdf` 1a) likely needs to
  hold a subdomain/base-URL, not a numeric workspace ID passed in the request body — unlike
  GHL where `locationId` is a value inside a shared `services.leadconnectorhq.com` API.

## Create or update lead (the "add to workspace" push) — CONFIRMED via emailbison-cli source

There are three lead-write endpoints, and the one we want is the bulk upsert-by-email —
it sidesteps the duplicate-handling question entirely:

- `POST /api/leads` — **create only**. Body: `email, first_name, last_name, company_name,
  title, phone, website, custom_variables`. This is presumably what 422s on a duplicate
  email (matches the ticket's "422 already taken" note) — **don't call this one**.
- `POST /api/leads/create-or-update/{lead_id}` — upsert by known ID (single lead). Not
  useful for us since we don't have a lead_id ahead of time.
- `POST /api/leads/create-or-update/multiple` — body `{leads: [...]}`, an array of lead
  objects (by email). **This is the one to use**: true upsert semantics, matches by email
  internally, no 422 to handle, and batches the whole filtered push in one call instead of
  one request per person.
- `custom_variables`: array of `{name, value}` — pass the variable's exact name, no ID
  lookup (matches the ticket doc). **But** the variable must already exist in the workspace
  — `GET /api/custom-variables` lists what's defined, `POST /api/custom-variables` (body:
  `{name}`) creates one. No auto-create on the lead write itself, so our push flow still
  needs a pre-step: for every custom variable name about to be sent, GET the existing list
  and POST-create any name not already present, invisible to the user.
- **Correction from Clay screenshots (2026-07-31)**: earlier notes assumed every active
  virtual column would auto-map to a custom variable with no UI step. **Clay's actual
  "Create or update lead" panel does not do this** — Custom Variables is a manual
  **"+ Add a new Custom Variable Name and Value pair"** row-adder (name + value chosen one
  at a time), plus a separate read-only **"Custom Variables Reference"** dropdown that just
  lists known workspace variable names for convenience ("Setting this will have no effect").
  So our UI should be the same shape: a manual add-row list for custom variables (each row:
  name text input or reference-list pick, value bound to a column/virtual-column), not an
  automatic map-every-active-virtual-column step. The invisible ensure-exists pre-step above
  still applies to whatever names the user actually adds.
- **New required field surfaced by the screenshots: "Existing Lead Behavior."** Per Clay's
  enrichment docs this chooses PATCH (update only the fields provided) vs PUT (full
  replace) when the lead already exists. Not mentioned in `tickets-info.pdf` at all — needs
  its own control in our "Add to EmailBison" step, defaulting to PATCH-equivalent (partial
  update) since that's the least destructive and most GHL-consistent choice, unless told
  otherwise.

## Add to campaign — CONFIRMED via emailbison-cli source

- `GET /api/campaigns` — **list campaigns exists** (paginated via `?page=`). Resolves the
  earlier open question: campaign selection can be a live-fetched dropdown, same pattern as
  GHL custom fields.
- `POST /api/campaigns/{campaign_id}/leads/attach-leads` — body `{lead_ids: [id, ...]}`
  (EmailBison's internal numeric/string lead ID, not email).
- `POST /api/campaigns/{campaign_id}/leads/attach-lead-list` — body `{lead_list_id}`, not
  needed for our flow.
- "Adding leads to an active campaign will take up to 5 minutes to sync" — async on
  EmailBison's side, not immediate like GHL's contact creation. Push summary should say
  "queued" rather than implying instant campaign membership.

Clay's "Import Lead(s) to Campaign" enrichment only requires `email` + `campaign_id` as
input — meaning Clay resolves email → lead_id internally before calling `attach-leads`.
**There is no bare "attach by email" endpoint.** Our "Add to Campaign" action needs to do
the same: create-or-update (by email, via the bulk endpoint above) first to get each
lead_id back, then call `attach-leads` with those IDs — auto-running step one silently if a
person was never pushed to the workspace before.

## Clay's four EmailBison enrichments (for reference — what we're replicating the shape of)

1. Find Lead — lookup by email or ID
2. Create or Update Lead — the "add to workspace" action
3. Import Lead(s) to Campaign — the "add to campaign" action, wraps find/create + attach
4. Blocklist management (add/remove email, add/remove domain) — not in scope per the ticket

## Resolved (was "open items")

- ~~Whether `custom_variables` auto-creates unknown names~~ — **No.** Must pre-create via
  `POST /api/custom-variables`; `GET /api/custom-variables` to check what exists first.
- ~~Full accepted field list for create-or-update lead~~ — **Confirmed**: `email,
  first_name, last_name, company_name, title, phone, website, custom_variables`.
- ~~Real request/response shape for duplicate email~~ — **Sidestepped**: use
  `POST /api/leads/create-or-update/multiple` (upsert by email), not `POST /api/leads`
  (create-only, which is what 422s). No duplicate-handling branch needed in our code if we
  always use the upsert endpoint.
- ~~Whether there's a list-campaigns endpoint~~ — **Yes**, `GET /api/campaigns`.

## Still open — needs a live token before implementing

- Exact base-URL-per-workspace scheme — is every client's workspace subdomain fixed, or
  does the account also expose a stable numeric `workspace_id` usable against a shared host?
  (`tickets-info.pdf` calls the column `emailbison_workspace_id`, implying an ID, not a URL.)
  The CLI's endpoints are all workspace-relative paths (`/api/...`) with the workspace
  presumably selected by which base URL/token you authenticate with, consistent with the
  earlier subdomain theory — but not proven without a real account to test against.
- Exact response body shape of `create-or-update/multiple` (does it return one lead_id per
  input in a matching array, keyed by email, etc.) — needed to reliably map each pushed
  person back to their EmailBison lead_id for the subsequent attach-to-campaign call.

Sources: https://docs.emailbison.com/low-code-tools/clay/enrichments ·
https://emailbison-306cc08e.mintlify.app/campaigns/adding-leads-to-a-campaign ·
https://emailbison-306cc08e.mintlify.app/leads/custom-variables ·
https://emailbison.com/developers · https://university.clay.com/docs/emailbison-integration ·
https://github.com/bcharleson/emailbison-cli (`src/commands/leads/*.ts`,
`src/commands/campaigns/*.ts`, `src/commands/custom-variables/*.ts` — real endpoint
method/path definitions)
