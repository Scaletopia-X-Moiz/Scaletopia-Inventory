# Companies push each other as their own EmailBison leads, not their linked People

> Supersedes the "Companies resolves to linked People" decision recorded in
> [0003-emailbison-two-push-actions.md](0003-emailbison-two-push-actions.md).
> That ADR's two-actions decision ("Add to EmailBison" / "Add to Campaign", each
> its own button) still stands unchanged — only the Companies-table resolution
> target changes here.

## Context

ADR 0003 stated the Companies-table EmailBison push "resolves to the linked
People" — there is no company-level EmailBison object, so triggering either
push action from the Companies table ran the People-table push logic against
every Person linked to the matched Companies
(`getPeopleForEmailBisonByCompanyFilters`). A Company with zero linked People
contributed nothing.

The user wants the opposite: the **Company itself** pushed as its own
EmailBison lead — `company` = the company's own brand/company name, `email` =
`companies.email` (the company's own email, not a linked person's) — mirroring
exactly how a Person is pushed today, with the same dedup and "pushed" status
tracking. A company with no email of its own is skipped, the same way an
emailless Person is skipped today (EmailBison upserts leads by email).

## Decision

The Companies-table EmailBison push (both "Add to EmailBison" and "Add to
Campaign") is now **company-native**:

- `getCompaniesForEmailBison` (`lib/data/companies.ts`) builds one
  `EmailBisonPushCandidate` per matched Company row — `id` is the COMPANY id,
  `record.email` is the company's own `companies.email`, `companyName`/
  `brandName` come from the company's own columns. `firstName`/`lastName`/
  `title` are always null (a company has no person name/title).
- The orchestrator (`lib/emailbison/push-to-emailbison.ts`) threads an
  `idColumn`/`targetTable` pair (`"person_id"`/`"people"` vs
  `"company_id"`/`"companies"`) through `writePushRows` and the campaign
  lookup/update queries, so one function body serves both entities instead of
  hard-coding `person_id`.
- `platform_pushes` gains a `company_id` column alongside `person_id`, with a
  check constraint enforcing exactly one is set per row, and its own
  `(company_id, client_id, platform)` unique index for company-side dedup —
  independent from the People dedup on the same table (`platform_pushes.platform`
  still identifies the external platform, "emailbison", not the entity; the
  entity is which id column is populated).
- `companies` gains `pushed_to_emailbison` / `pushed_to_emailbison_at`,
  mirroring `people`'s existing pair.
- `push_job_records` (the per-run "who did this job touch" tag table) gains a
  `company_id` column and its own `(push_job_id, company_id)` unique index, so
  a companies job's per-record tagging (`recordJobPeople`, generalized with an
  `entity` parameter) writes company ids instead of failing a `person_id`
  NOT NULL constraint.
- The default-field-mapping preview (`resolveDefaultFieldMapping`) defaults
  `firstName`/`lastName`/`title` to `"skip"` for a `entity: "companies"` push,
  since a company row has no source column for any of them, and the
  companyName-brand-preference check now reads the company's own `brand_name`
  (`filteredCompaniesHaveOwnBrandName`) instead of a linked person's.

See `lib/data/emailbison-company-push.sql` for the exact DDL — it must be
applied by hand in the Supabase SQL editor (same constraint as
`push-jobs.sql`: the local `DATABASE_URL` password is stale, so there is no
automated migration path).

GHL's Companies-table push is **unaffected** — it still resolves to linked
People, per CONTEXT.md's "Companies-table push" glossary entry, which is now
EmailBison-specific rather than a blanket "GHL or EmailBison" statement.

## Consequences

- A Companies-table EmailBison push and a People-table EmailBison push to the
  same client are now fully independent: pushing a Company as a lead does not
  affect, and is not affected by, whether its linked People have been pushed
  (or vice versa). Both can coexist as separate `platform_pushes` rows for the
  same client.
- A Company with no email of its own is skipped by the push (same `pushChunk`
  no-email-on-record path that already skips emailless People) — it is no
  longer relevant whether the company has any linked People at all. The old
  "company with no linked people contributes nothing" UI copy is replaced with
  "company with no email of its own is skipped."
- The Companies push dialogs' bindable-column lists (custom variables,
  standard-field mapping) are now Company-specific — no `firstName`/
  `lastName`/`title`/`phoneType`/`linkedinUsername` (person-only fields a
  Company candidate never populates).
- `getPeopleForEmailBisonByCompanyFilters` (the old resolve-to-linked-People
  loader) and its `fetchFullPeopleByCompanyIds` helper are removed from
  `lib/data/people.ts` — nothing else referenced them.
