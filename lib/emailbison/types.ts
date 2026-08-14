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
}

/** Wire-level shape sent to EmailBison's create-or-update lead endpoint
 * (lib/emailbison/client.ts's upsertLeadsBulk). `existingLeadBehavior`
 * chooses between a partial update ("patch", the default per issue #52) and
 * a full replace ("put") when the lead already exists in the workspace. */
export interface EmailBisonLeadPayload {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  title: string | null;
  phone: string | null;
  website: string | null;
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
 * EmailBison lead field on a given push. EmailBison's 7 destination fields
 * are fixed (mirrors GhlStandardFieldMapping's field set, swapping GHL's
 * city/country for EmailBison's title/website) — the freedom is in WHICH of
 * our columns feeds each one: every value here is either a source-column key
 * (a PushRecord field name like "firstName", or "brandName" for the cleaned
 * company name, or any custom_data/virtual-column key) or the sentinel
 * "skip" meaning "don't send this field". Free-form source mapping, mirroring
 * the CSV importer's "Map Columns" screen (app/import/page.tsx) — previously
 * this was a fixed 3-way companyName enum plus include/skip toggles on the
 * rest. Legacy saved values ("include", "brand_name", "company_name") are
 * normalized to this shape by lib/emailbison/lead-payload.ts's
 * normalizeFieldSource, so old saved mappings/queued jobs keep working.
 * Optional on payload builders/orchestrators — omitting it keeps today's
 * always-include, prefer-brand-name behavior. */
export interface EmailBisonStandardFieldMapping {
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  title: string;
  website: string;
}
