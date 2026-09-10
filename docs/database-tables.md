# Database Tables — Scaletopia Inventory

> Reference for the tables this application owns and uses in the shared
> **Scaletopia Data Inventory** Supabase project (`swfykpknnfunpapzoudn`).
>
> Purpose: this Supabase project is shared with at least one other system. This
> document records exactly which tables belong to the Inventory app and what each
> one is for, so that other teams working in the same database know what is in
> use here and avoid changing it unintentionally.
>
> Scope was verified by tracing every table reference (`.from("…")`, raw SQL) in
> the application source, not just guessed from names.

## Tables owned by this app

These 14 tables are read and written by the Inventory application.

### Core inventory

| Table | Used for |
|-------|----------|
| `companies` | The main list of companies — the core company inventory. One row per business, with its details and enrichment data. |
| `people` | The list of individual contacts (people at those companies), with their information. Linked to `companies`. |
| `clients` | The list of clients that leads are prepared for. Used to tag and filter records by client. |

### Import pipeline (bringing leads in)

| Table | Used for |
|-------|----------|
| `import_history` | A log of every data import: what was uploaded, how many records came in, how many were inserted vs. updated, and any that failed. |
| `import_provider_mappings` | Saved per-source settings that tell the importer how each data source's columns map into our schema, so uploads line up automatically. |

### Push pipeline (sending leads out to external platforms)

| Table | Used for |
|-------|----------|
| `platform_pushes` | The record of every contact sent out to an external tool (EmailBison, GoHighLevel, Clay) — who was pushed, to which platform, and when. Also drives dedup on re-push. |
| `push_jobs` | One row per batch send. Tracks the overall progress and result of a push (queued / running / succeeded / failed / partial). |
| `push_job_records` | The per-contact detail inside a push job — whether each individual record succeeded or failed. |
| `push_field_mappings` | Configuration for which fields get sent to each external platform during a push. |
| `clay_push_runs` | A log of pushes sent to Clay specifically (for enrichment). |

### Application (tickets, audit, auth)

| Table | Used for |
|-------|----------|
| `tickets` | The in-app tickets feature for raising requests and reporting problems. |
| `ticket_attachments` | Images and voice notes attached to tickets. |
| `activity_log` | A running history of actions taken in the app (audit trail). |
| `profiles` | The app's user accounts and login access. |

## Tables NOT owned by this app

Every other table and view in this Supabase project belongs to a **separate
system** (an AI copywriting / sales-intelligence pipeline) that shares the same
database. The Inventory application does not read or write any of them.

Known examples (non-exhaustive): `copies`, `copy_components`, `copy_metrics`,
`campaigns`, `deals`, `case_studies`, `master_sheet_pains`, `niche_knowledge`,
`niches`, `client_calls`, `call_chunks`, `client_roster`, `client_aliases`,
`client_drafts`, `contacts`, `slack_messages`, `daily_stats`, `direction_sheets`,
`offers`, `guidelines`, `materials`, `material_chunks`, `bug_tickets`,
`bug_ticket_assignees`, `bug_ticket_state`, and the views `winners`, `losers`,
`copy_performance`, `campaign_rollup`.

**Note:** `clients` is the one table both systems touch. Coordinate before
changing its shape.
