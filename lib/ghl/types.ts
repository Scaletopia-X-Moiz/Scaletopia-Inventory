/** Combined person+company fields needed to push a contact to GHL. Mirrors
 * the columns already denormalized onto a people row (employee_count,
 * niche, country, source) so the push orchestrator (ticket 47) can select
 * them directly without joining to companies. */
export interface GhlPushRecord {
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
  city: string | null;
  country: string | null;
  niche: string | null;
  employeeCount: number | null;
  source: string | null;
  /** Remaining person-own real columns (ground-truth audit against the live
   * `people` table, 2026-08-15 — mirrors the equivalent EmailBisonPushRecord
   * audit in lib/emailbison/types.ts, but scoped to GHL's own contact
   * schema/BINDABLE_RECORD_COLUMNS). `state` fills a genuine gap (city and
   * country were already bindable, state wasn't). `title`/`website` reuse
   * EmailBison's job_title/domain field choice and label text ("Title"/
   * "Website (domain)") even though GHL's own 7 standard fields don't include
   * them — they're still legitimate custom-field bind targets. Deliberately
   * excludes the same columns EmailBisonPushRecord excludes, for the same
   * reasons (see that type's doc comment): id/company_id, pushed_to_*
   * bookkeeping, custom_data, country_id/industry_id, source_tokens/
   * niche_tokens, job_title (covered by `title`), and employee_count/
   * company_linkedin_url (confirmed via live-data probe to be exact synced
   * mirrors of the linked company's own employee_count/linkedin_url). */
  title: string | null;
  website: string | null;
  state: string | null;
  fullName: string | null;
  linkedinUrl: string | null;
  linkedinUsername: string | null;
  phoneType: string | null;
  phoneStatus: string | null;
  emailStatus: string | null;
  sourceId: string | null;
  tags: string[] | null;
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;
  lastUpdated: string | null;
  createdAt: string | null;
  /** The linked company's real columns (people.company_id -> companies.id
   * embed), namespaced with a `company*` prefix — mirrors
   * EmailBisonPushRecord's company* fields (lib/emailbison/types.ts).
   * Deliberately omits companyEmployeeCount/companyNiche/companySource: this
   * type already exposes the linked company's employee count/niche/source
   * directly as `employeeCount`/`niche`/`source` above (denormalized straight
   * onto the person row and confirmed via a live-data probe to be exact
   * synced mirrors of the company's own columns) — a company*-namespaced
   * duplicate would be a redundant option with zero information gain. All
   * null when the person has no linked company. */
  companyCity: string | null;
  companyState: string | null;
  companyCountry: string | null;
  companyIndustry: string | null;
  companyWebsiteUrl: string | null;
  companyLinkedinUrl: string | null;
  companyDomain: string | null;
  companyPhone: string | null;
  companyPhoneType: string | null;
  companyPhoneStatus: string | null;
  companyEmail: string | null;
  companyEmailStatus: string | null;
  companyEmailVerifiedAt: string | null;
  companyPhoneVerifiedAt: string | null;
  companyQualityTier: string | null;
  companyClient: string | null;
  companyDescription: string | null;
  companyFoundedYear: number | null;
  /** companies.revenue is a text column in the live schema (e.g. "0-99999",
   * "USD $6,000.00"), not numeric — confirmed via a live-data probe. */
  companyRevenue: string | null;
  companyDomainStatus: string | null;
  companyMxProvider: string | null;
  companySecurityGateway: string | null;
  companyKeywords: string[] | null;
  companyTechnologies: string[] | null;
  companyTags: string[] | null;
  companyCreatedAt: string | null;
  companyLastUpdated: string | null;
}

/** Shape produced by buildGhlContactPayload — distinct from lib/ghl/client.ts's
 * own GhlContactPayload (the wire-level shape with optional, non-null fields
 * sent straight to GHL's API). This one uses `| null` for missing fields,
 * matching this repo's Detail/Row conventions; the push orchestrator
 * (ticket 47) is expected to convert between the two. */
export interface GhlContactPayloadShape {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  city: string | null;
  country: string | null;
  tags: string[];
  /** GHL custom-field values built from the field-mapping step (ticket #51) —
   * one entry per mapped virtual column that had a non-empty value on this
   * candidate. Empty when no virtual columns are active or none are mapped.
   * Sent to GHL on the wire as `customFields` (plural, see lib/ghl/client.ts). */
  customFields: { id: string; value: string }[];
}

/** One user-chosen mapping for a GHL custom field, collected by the push
 * button's mapping step (ticket #51, extended by #142 for EmailBison parity)
 * and sent to the push route alongside `clientId`. A "column" entry binds to
 * a standard record field or a virtual/enrichment column (`columnKey`,
 * resolved by buildGhlCustomFields against GhlPushRecord first, falling back
 * to custom_data); a "literal" entry sends `value` verbatim to every pushed
 * contact. Mirrors EmailBisonCustomVariableEntry's literal/column duality
 * (lib/emailbison/types.ts), but kept explicit (`source`) rather than
 * inferring literal-from-absent-columnKey since GHL's entry is keyed by
 * ghlFieldId, not a user-typed name. */
export interface GhlFieldMapping {
  /** The target GHL custom field's id (GhlCustomField.id from ticket #49). */
  ghlFieldId: string;
  source: "column" | "literal";
  /** Required when source === "column": a GhlPushRecord field name (see
   * buildGhlCustomFields's GHL_KNOWN_RECORD_FIELDS) or a virtual/enrichment
   * column key, resolved against the pushed candidate's custom_data. */
  columnKey?: string;
  /** Required when source === "literal": sent verbatim to every contact. */
  value?: string;
}

/** The user-chosen (or auto-mapped, ticket #108) source for each standard
 * GHL contact field on a given push. GHL's 7 destination fields are fixed
 * (mirrors EmailBisonStandardFieldMapping's field set, swapping EmailBison's
 * title/website for GHL's city/country) — the freedom is in WHICH of our
 * columns feeds each one: every value here is either a source-column key (a
 * GhlPushRecord field name like "firstName", or "brandName" for the cleaned
 * company name, or any custom_data/virtual-column key) or the sentinel
 * "skip" meaning "don't send this field". Free-form source mapping, mirroring
 * the CSV importer's "Map Columns" screen (app/import/page.tsx) — previously
 * this was a fixed 3-way companyName enum plus include/skip toggles on the
 * rest. Legacy saved values ("include", "brand_name", "company_name") are
 * normalized to this shape by lib/ghl/contact-payload.ts's
 * normalizeGhlFieldSource, so old saved mappings/queued jobs keep working.
 * Distinct from `GhlFieldMapping`, which covers custom fields, not these
 * fixed standard ones. Optional on payload builders/orchestrators — omitting
 * it keeps today's always-include, prefer-brand-name behavior. */
export interface GhlStandardFieldMapping {
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  country: string;
}
