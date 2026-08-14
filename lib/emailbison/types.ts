/** Per-client EmailBison credentials, mirrors GhlCredentials
 * (lib/ghl/client.ts) — read from clients.emailbison_api_key /
 * clients.emailbison_workspace_id (ticket 46). workspaceId picks the
 * per-client base URL the same way locationId does for GHL. */
export interface EmailBisonCredentials {
  apiKey: string;
  workspaceId: string;
}

/** Combined person+company fields needed to push a lead to EmailBison.
 * Mirrors GhlPushRecord (lib/ghl/types.ts) — just the fields
 * EmailBisonLeadPayload needs, since EmailBison's lead object differs from
 * GHL's contact object (title/website instead of city/country/niche/etc). */
export interface EmailBisonPushRecord {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  /** The linked company's cleaned name (companies.brand_name), joined in
   * alongside the raw companyName above so the push payload can prefer it.
   * null when the company has no linked row or hasn't been cleaned yet, in
   * which case the raw companyName is used instead. */
  brandName: string | null;
  title: string | null;
  website: string | null;
  /** The person's own real columns, exposed so any people row column is
   * bindable in the push dialogs (not just the 8 legacy fields). Sourced
   * directly from the person row, distinct from the company* fields below
   * which come from the linked company embed. */
  city: string | null;
  state: string | null;
  country: string | null;
  fullName: string | null;
  linkedinUrl: string | null;
  linkedinUsername: string | null;
  phoneType: string | null;
  phoneStatus: string | null;
  emailStatus: string | null;
  sourceId: string | null;
  /** Remaining person-own real columns (ground-truth audit against the live
   * `people` table, 2026-08-15, same pass that added the company* fields
   * below). tags is JSON-stringified by resolveEmailBisonColumnValue's
   * stringifier since it's an array; the two verified-at timestamps are
   * legitimate real columns even though email_verified_at is sparsely
   * populated in production (3/24593 live rows at audit time) — kept per this
   * audit's "include timestamps unless there's a concrete reason not to"
   * rule. Deliberately excluded (see also the company* doc comment below for
   * the equivalent company-side calls): `id`/`company_id` (PKs/FKs);
   * `pushed_to_emailbison[_at]`/`pushed_to_ghl[_at]` (internal push-tracking
   * — circular to push "pushed_to_emailbison" back into EmailBison itself);
   * `custom_data` (its keys are already offered separately via the
   * enrichment-fields mechanism); `country_id`/`industry_id` (duplicate the
   * already-exposed country/companyIndustry labels — confirmed via probe that
   * industry_id already holds a human string, e.g. "marketing and
   * advertising", identical to the linked company's industry, not an opaque
   * id); `source_tokens`/`niche_tokens` (raw arrays duplicating the
   * already-exposed sourceId/companyNiche); the raw `source` string (a
   * comma/ampersand-delimited combination of source_tokens — sourceId is the
   * cleaner single label to expose); `job_title` (already exposed as
   * `title`); and `employee_count`/`company_linkedin_url` — confirmed via a
   * live-data probe (8/8 sampled QA rows) to be exact synced mirrors of
   * companies.employee_count/linkedin_url, already exposed below as
   * companyEmployeeCount/companyLinkedinUrl — exposing both would be a
   * duplicate with zero information gain. */
  tags: string[] | null;
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;
  lastUpdated: string | null;
  createdAt: string | null;
  /** The linked company's real columns (people.company_id -> companies.id
   * embed), namespaced with a `company*` prefix so they never collide with
   * the person's own same-named fields above. Makes every real company column
   * bindable in the Companies-side push dialogs alongside the enrichment
   * (custom_data) fields. All null when the person has no linked company. */
  companyCity: string | null;
  companyState: string | null;
  companyCountry: string | null;
  companyIndustry: string | null;
  companyEmployeeCount: number | null;
  companyWebsiteUrl: string | null;
  companyLinkedinUrl: string | null;
  companyDomain: string | null;
  companyPhone: string | null;
  companyPhoneType: string | null;
  companyEmail: string | null;
  companyEmailStatus: string | null;
  companyNiche: string | null;
  companyQualityTier: string | null;
  /** Ground-truth audit (docs/emailbison-push-test-plan.md-adjacent companies
   * push-dialog audit) found 16 more real `companies` columns with no
   * bindable field yet — companyPhoneStatus fills a genuine gap (phone_type
   * was covered, phone_status wasn't); the rest (client/timestamps/
   * description/domain_status/founded_year/mx_provider/revenue/
   * security_gateway/source/keywords/tags/technologies) had no bindable
   * field at all. Excluded on purpose: id, country_id/industry_id (duplicate
   * the already-exposed country/industry labels), custom_data (its keys are
   * already offered separately via the enrichment-fields mechanism),
   * pushed_to_clay/pushed_to_clay_at (internal bookkeeping), source_tokens
   * (raw tokenized array — companySource's plain string already covers it). */
  companyPhoneStatus: string | null;
  companyClient: string | null;
  companyCreatedAt: string | null;
  companyDescription: string | null;
  companyDomainStatus: string | null;
  companyEmailVerifiedAt: string | null;
  companyFoundedYear: number | null;
  companyKeywords: string[] | null;
  companyLastUpdated: string | null;
  companyMxProvider: string | null;
  companyPhoneVerifiedAt: string | null;
  /** companies.revenue is a text column in the live schema (e.g. "0-99999",
   * "USD $6,000.00" — a bucket label or free-text string, not a numeric
   * value), confirmed via a live-data probe; typed as string, not number. */
  companyRevenue: string | null;
  companySecurityGateway: string | null;
  companySource: string | null;
  companyTags: string[] | null;
  companyTechnologies: string[] | null;
}

/** Wire-level shape sent to EmailBison's create-or-update lead endpoint
 * (lib/emailbison/client.ts's upsertLeadsBulk). `existingLeadBehavior`
 * chooses between a partial update ("patch", the default per issue #52) and
 * a full replace ("put") when the lead already exists in the workspace.
 *
 * No `phone`/`website` fields — ground-truth audit (2026-08-15) against
 * `.scratch/eb-openapi.yaml`'s request schema confirmed EmailBison's
 * lead-write endpoints accept ONLY `first_name, last_name, email, title,
 * company, notes, custom_variables` at the top level; phone/website are not
 * native lead fields at all. Per the fixing principle, they're not given a
 * secret auto-routing exception — a user who wants to send phone/website
 * data sends it exactly like any other non-native field: as a
 * `custom_variables` entry, via the existing custom-variable UI (the phone/
 * website columns remain bindable there, see EmailBisonPushRecord). */
export interface EmailBisonLeadPayload {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  title: string | null;
  existingLeadBehavior: "patch" | "put";
  customVariables: { name: string; value: string }[];
}

/** One manually-added custom-variable row from the Add-to-EmailBison step's
 * UI (issue #52) — analogous to GhlFieldMapping (lib/ghl/types.ts) but a
 * direct name/value entry rather than a virtual-column-to-field mapping,
 * matching Clay's own custom-variable panel. A row's value is either a
 * literal (`value`, the default) or bound to a People-table column/virtual
 * column (`columnKey` set, `value` ignored) — resolved per-candidate at push
 * time by lib/emailbison/lead-payload.ts's resolveCustomVariables, reading
 * from the candidate's record fields or custom_data. Unset/omitted
 * `columnKey` keeps this a pass-through literal, matching how earlier
 * tickets (#56-#60) already produce/consume this shape. */
export interface EmailBisonCustomVariableEntry {
  name: string;
  value: string;
  columnKey?: string;
}

/** The user-chosen (or auto-mapped, ticket #108) source for each standard
 * EmailBison lead field on a given push. EmailBison's 5 destination fields
 * are fixed (mirrors GhlStandardFieldMapping's field set) — the freedom is in
 * WHICH of our columns feeds each one: every value here is either a
 * source-column key (a PushRecord field name like "firstName", or
 * "brandName" for the cleaned company name, or any custom_data/virtual-column
 * key) or the sentinel "skip" meaning "don't send this field". Free-form
 * source mapping, mirroring the CSV importer's "Map Columns" screen
 * (app/import/page.tsx) — previously this was a fixed 3-way companyName enum
 * plus include/skip toggles on the rest. Legacy saved values ("include",
 * "brand_name", "company_name") are normalized to this shape by
 * lib/emailbison/lead-payload.ts's normalizeFieldSource, so old saved
 * mappings/queued jobs keep working. Optional on payload builders/
 * orchestrators — omitting it keeps today's always-include, prefer-brand-name
 * behavior.
 *
 * No `phone`/`website` — ground-truth audit (2026-08-15) confirmed those
 * aren't native EmailBison lead fields (see EmailBisonLeadPayload's doc
 * comment); they were removed from the standard-field set so they're sent
 * the same way as any other non-native field, through a custom-variable row,
 * not through a special-cased standard-field slot. */
export interface EmailBisonStandardFieldMapping {
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  title: string;
}
