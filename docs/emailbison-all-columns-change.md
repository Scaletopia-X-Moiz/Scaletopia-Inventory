# EmailBison push: make all real company/person columns bindable

Goal: every real database column of a company (and person) is bindable as a
"column" in the EmailBison push dialogs, alongside the existing enrichment
(`custom_data`) fields — not just the 8 hardcoded record fields.

## (a) No SQL / DDL is required

**Zero schema changes.** Every column exposed already exists:

- The company columns (`city`, `state`, `country`, `industry`,
  `employee_count`, `website_url`, `linkedin_url`, `domain`, `phone`,
  `phone_type`, `email`, `email_status`, `niche`, `quality_tier`,
  `brand_name`) are already real columns on the `companies` table — confirmed
  against `RawCompanyRow` / `LIST_COLUMNS` in `lib/data/companies.ts`.
- The person columns (`city`, `state`, `country`, `full_name`, `linkedin_url`,
  `linkedin_username`, `phone_type`, `phone_status`, `email_status`,
  `source_id`) are already real columns on the `people` table — confirmed
  against `RawPersonRow` / `FullPersonRow` in `lib/data/people.ts`.

The change is purely **TypeScript + a wider PostgREST `select` string**. The
company columns are pulled through the existing `companies(...)` foreign-table
embed on the people-row fetch (`people.company_id -> companies.id`); widening
that embed needs no new tables, columns, or relationships.

## (b) Files changed

| File | Change |
| --- | --- |
| `lib/emailbison/types.ts` | Extended `EmailBisonPushRecord` with 10 person-namespaced fields + 14 `company*`-namespaced fields (all `string \| null`, except `companyEmployeeCount: number \| null`). Existing 8 fields untouched. Added doc comments. |
| `lib/data/people.ts` | (a) Widened `FULL_ROW_COLUMNS` embed from `companies(brand_name)` to pull all 14 company columns + `brand_name`. (b) Widened `FullPersonRow.companies` type accordingly. (c) `toEmailBisonPushRecord` now populates every new person field from the person row and every `company*` field from `row.companies?.<col> ?? null`. |
| `lib/emailbison/lead-payload.ts` | Added all 24 new keys to `KNOWN_RECORD_FIELDS` (identity mapping key -> record field) so they resolve from the record, not the `custom_data` enrichment blob. |
| `components/companies/push-to-emailbison-button.tsx` | Appended the 14 company columns to `BINDABLE_RECORD_COLUMNS` (existing 8 kept first). |
| `components/companies/push-to-emailbison-campaign-button.tsx` | Same 14-column append (this button keeps its own in-sync copy of the list). |
| `lib/emailbison/lead-payload.test.ts` | Completed the two `EmailBisonPushRecord` fixtures with the new fields and typed them as `EmailBisonPushRecord` (all other fixtures spread these). |
| `lib/data/people-emailbison.test.ts` | Updated the exact `toEqual` record-shape assertion to include the new fields. |

No `components/people/*` file was touched — the People-side dropdown is owned
by the People agent; this change only lays the shared plumbing (types,
`people.ts`, `lead-payload.ts`) so those files are edited once.

## (c) New bindable keys -> labels

### Company side (added to both Companies push-dialog buttons)

| Key | Label |
| --- | --- |
| `companyCity` | City |
| `companyState` | State |
| `companyCountry` | Country |
| `companyIndustry` | Industry |
| `companyEmployeeCount` | Employees |
| `companyWebsiteUrl` | Website URL |
| `companyLinkedinUrl` | Company LinkedIn |
| `companyDomain` | Domain |
| `companyPhone` | Company phone |
| `companyPhoneType` | Company phone type |
| `companyEmail` | Company email |
| `companyEmailStatus` | Company email status |
| `companyNiche` | Niche |
| `companyQualityTier` | Quality tier |

(Company name / cleaned brand name / website are already covered by the
existing `companyName` / `brandName` / `website` entries and were not
duplicated.)

### Person side (plumbing only — record fields + `KNOWN_RECORD_FIELDS`)

Plain keys sourced from the person row directly (People agent will surface
these in `components/people/*`):

`city`, `state`, `country`, `fullName`, `linkedinUrl`, `linkedinUsername`,
`phoneType`, `phoneStatus`, `emailStatus`, `sourceId`

Sourced from `row.city`, `row.state`, `row.country`, `row.full_name`,
`row.linkedin_url`, `row.linkedin_username`, `row.phone_type`,
`row.phone_status`, `row.email_status`, `row.source_id`.

## (d) Validation results

- **Typecheck** — `npx tsc --noEmit`: no new errors introduced. The single
  remaining error (`lib/import/csv.test.ts`) is **pre-existing** and unrelated
  (verified by stashing this change — the error persists without it).
- **`lib/emailbison/lead-payload.test.ts`** — 32/32 passed.
- **`lib/data/people-emailbison.test.ts`** (live DB) — 4/4 passed. The updated
  record-shape assertion passing against the real database confirms the
  widened `companies(...)` embed resolves and populates every field
  end-to-end.
- **`lib/emailbison/push-to-emailbison.test.ts` + `client.test.ts`** —
  71/71 passed.

## Risks / follow-ups

- The `KNOWN_RECORD_FIELDS` fall-through means any bindable key NOT in that map
  is looked up in `custom_data`. All 24 new keys are now in the map, so none
  can silently resolve against enrichment data. If a future enrichment column
  happens to be named identically to one of these keys, the record field now
  wins — expected, and namespaced `company*` keys make collisions unlikely.
- The People-side UI change (adding the 10 person keys to
  `components/people/*` push dialogs) is intentionally left to the People agent
  — the shared plumbing it needs is already in place here.
- No commit made; changes left in the working tree.
