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
  title: string | null;
  website: string | null;
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
