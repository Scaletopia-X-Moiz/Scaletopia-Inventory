import "server-only";
import type { EmailBisonCredentials, EmailBisonLeadPayload } from "@/lib/emailbison/types";

export const EMAILBISON_RETRY_MAX_RETRIES = 5;
const EMAILBISON_RETRY_BASE_DELAY_MS = 500;
export const EMAILBISON_RETRY_MAX_DELAY_MS = 8_000;

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

export class EmailBisonApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmailBisonApiError";
    this.status = status;
  }
}

export interface EmailBisonClientDeps {
  fetchImpl?: typeof fetch;
}

/** One upserted lead as returned by the create-or-update endpoint. Response
 * shape is unconfirmed against a live token (see api-research.md's "Still
 * open" section) — fields are extracted defensively so a workspace that
 * returns a slightly different envelope doesn't throw. */
export interface EmailBisonLeadResult {
  id: string;
  email: string | null;
}

export interface EmailBisonCampaign {
  id: string;
  name: string;
  /** EmailBison's campaign status (e.g. "draft", "active"). A campaign is
   * considered "not launched / a draft" when `status === "draft"`. Extracted
   * best-effort: the create response is confirmed to include `status: "draft"`,
   * but it is UNCONFIRMED whether the `/api/campaigns` LIST endpoint returns
   * per-row status, so this is `undefined` when absent. A freshly-created
   * campaign carries status from the create response regardless. */
  status?: string;
}

export interface ListCampaignsResult {
  campaigns: EmailBisonCampaign[];
  page: number;
  hasMore: boolean;
}

export interface EmailBisonCustomVariable {
  id: string;
  name: string;
}

function emailBisonHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function backoffMs(attempt: number): number {
  const exp = Math.min(EMAILBISON_RETRY_BASE_DELAY_MS * 2 ** attempt, EMAILBISON_RETRY_MAX_DELAY_MS);
  return exp + Math.random() * 250; // jitter so a burst doesn't retry in lockstep
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

interface RawResponse {
  status: number;
  json: unknown;
}

/** Shared retry/backoff loop for EmailBison requests, mirroring
 * lib/ghl/client.ts's requestWithMethodRetry. `credentials.workspaceId` holds
 * the base URL of the shared EmailBison instance (e.g.
 * "https://send.scaletopia.io") rather than a numeric id — a workspace is
 * actually scoped by the API token (`credentials.apiKey`), not this URL, but
 * the URL is still needed to reach the instance. A trailing slash on
 * `workspaceId` (e.g. from how it was entered in the client's settings)
 * would otherwise double up with `path`'s leading slash and 404, so it's
 * stripped before concatenating. */
async function requestWithMethodRetry(
  fetchImpl: typeof fetch,
  credentials: EmailBisonCredentials,
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  body?: Record<string, unknown>
): Promise<RawResponse> {
  let attempt = 0;
  for (;;) {
    let resp: Response;
    try {
      const baseUrl = credentials.workspaceId.replace(/\/$/, "");
      resp = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: emailBisonHeaders(credentials.apiKey),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      if (attempt >= EMAILBISON_RETRY_MAX_RETRIES) {
        throw new EmailBisonApiError(err instanceof Error ? err.message : String(err));
      }
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      attempt++;
      continue;
    }

    if (TRANSIENT_STATUSES.has(resp.status)) {
      if (attempt >= EMAILBISON_RETRY_MAX_RETRIES) {
        throw new EmailBisonApiError(
          `EmailBison request to ${path} failed with status ${resp.status}`,
          resp.status
        );
      }
      const retryAfterMs =
        resp.status === 429 ? parseRetryAfterMs(resp.headers?.get?.("Retry-After") ?? null) : null;
      const delayMs =
        retryAfterMs != null ? Math.min(retryAfterMs, EMAILBISON_RETRY_MAX_DELAY_MS) : backoffMs(attempt);
      await new Promise((r) => setTimeout(r, delayMs));
      attempt++;
      continue;
    }

    const json = await resp.json().catch(() => null);
    return { status: resp.status, json };
  }
}

/** POSTs `body` to `path` with retry/backoff for transient failures.
 * Exported for tests: exercises the retry/backoff logic in isolation. */
export async function requestWithRetry(
  fetchImpl: typeof fetch,
  credentials: EmailBisonCredentials,
  path: string,
  body: Record<string, unknown>
): Promise<RawResponse> {
  return requestWithMethodRetry(fetchImpl, credentials, "POST", path, body);
}

/** GETs `path` with the same retry/backoff behavior as requestWithRetry. */
export async function requestGetWithRetry(
  fetchImpl: typeof fetch,
  credentials: EmailBisonCredentials,
  path: string
): Promise<RawResponse> {
  return requestWithMethodRetry(fetchImpl, credentials, "GET", path);
}

/** PATCHes `path` (with an optional body) using the same retry/backoff
 * behavior as requestWithRetry. */
export async function requestPatchWithRetry(
  fetchImpl: typeof fetch,
  credentials: EmailBisonCredentials,
  path: string,
  body?: Record<string, unknown>
): Promise<RawResponse> {
  return requestWithMethodRetry(fetchImpl, credentials, "PATCH", path, body);
}

/** PUTs `body` to `path` with the same retry/backoff behavior as
 * requestWithRetry. */
export async function requestPutWithRetry(
  fetchImpl: typeof fetch,
  credentials: EmailBisonCredentials,
  path: string,
  body: Record<string, unknown>
): Promise<RawResponse> {
  return requestWithMethodRetry(fetchImpl, credentials, "PUT", path, body);
}

function assertOk(status: number, json: unknown, action: string): void {
  if (status < 200 || status >= 300) {
    throw new EmailBisonApiError(`EmailBison ${action} failed with status ${status}: ${JSON.stringify(json)}`, status);
  }
}

/** EmailBison sometimes returns HTTP 2xx with a body shaped like
 * `{ data: { success: false, message: "..." } }` for what is semantically a
 * failure (confirmed live on a schedule-not-found GET). assertOk only checks
 * the HTTP status range, so write calls that can hit this shape must also
 * call this after assertOk to catch it. */
function assertSuccessBody(json: unknown, action: string): void {
  if (!json || typeof json !== "object") return;
  const data = (json as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return;
  const record = data as Record<string, unknown>;
  if (record.success === false) {
    const message = typeof record.message === "string" ? record.message : "unknown error";
    throw new EmailBisonApiError(`EmailBison ${action} failed: ${message}`);
  }
}

/** Converts our camelCase EmailBisonLeadPayload (lib/emailbison/types.ts)
 * into the snake_case field names the create-or-update lead endpoints
 * actually accept, per the request-body schema in `.scratch/eb-openapi.yaml`
 * (checked across every lead-write endpoint: POST /api/leads,
 * /api/leads/create-or-update/{lead_id}, /api/leads/create-or-update/multiple,
 * and the bulk-create endpoint — all five expose the exact same request
 * shape: `first_name, last_name, email, title, company, notes,
 * custom_variables`). Two corrections from api-research.md's
 * `company_name`/phone/website belief, confirmed live (`title` and
 * `custom_variables` land, company never did):
 *  - `company` is the real key, not `company_name` — the response/example
 *    bodies throughout the schema use `company:` (e.g. line ~2436, ~3166),
 *    and the request schema itself names the property `company`. Sending
 *    `company_name` means EmailBison silently drops the whole field.
 *  - `phone` and `website` are NOT in the request schema on ANY lead-write
 *    endpoint — only `first_name, last_name, email, title, company, notes,
 *    custom_variables` are accepted top-level keys. There is no alternate
 *    accepted key for phone/website either; the schema's only phone/website-
 *    shaped examples (e.g. `company_website`) appear solely as arbitrary
 *    example *custom_variables* names on unrelated endpoints, not as a
 *    documented convention for our phone/website fields. EmailBisonLeadPayload
 *    (lib/emailbison/types.ts) no longer carries phone/website at all — per
 *    the fixing principle, they're not native fields, so they're not given
 *    any special top-level (or auto-routed custom-variable) treatment here;
 *    a user who wants to send phone/website data adds an ordinary
 *    custom-variable row bound to the phone/website column, exactly like any
 *    other non-native field.
 * `existing_lead_behavior` is NOT one of those confirmed fields either —
 * it's our own unverified guess at how to wire up the "Existing Lead
 * Behavior" (PATCH-vs-PUT) control Clay's UI surfaces, since the research
 * doc never pins down a body-field name for it. CONFIRMED WORKING via a live
 * patch-vs-put test — but it is a TOP-LEVEL property of the
 * `/api/leads/create-or-update/multiple` request body (a sibling of
 * `leads`), per the OpenAPI spec, not a per-lead field. `upsertLeadsBulk`
 * sends it once, at the top level, for the whole batch. EmailBison defaults
 * `existing_lead_behavior` to "put" (full replace — wipes fields/custom
 * variables not included in the push) whenever it's absent, so it must
 * never be omitted from the top-level body. */
function toWireLead(lead: EmailBisonLeadPayload): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    email: lead.email,
    first_name: lead.firstName,
    last_name: lead.lastName,
    company: lead.companyName,
    title: lead.title,
  };
  // EmailBison treats an explicit `custom_variables: []` as "clear all
  // existing custom variables" on a patch (confirmed live: an empty-array
  // patch wiped previously-set qa_* vars), so a push with no custom
  // variables selected must omit the key entirely rather than send `[]` —
  // that's the only way "nothing to say about custom variables" and
  // "explicitly clear them" stay distinguishable on the wire. Under a
  // proper top-level "patch" an omitted custom_variables key is kept as-is;
  // omitting it here is also defense-in-depth against the "put" default if
  // the top-level behavior field were ever missing.
  if (lead.customVariables.length > 0) {
    wire.custom_variables = lead.customVariables.map(({ name, value }) => ({ name, value }));
  }
  return wire;
}

function extractArray(json: unknown): unknown[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as Record<string, unknown>).data;
  return Array.isArray(data) ? data : [];
}

function toLeadResult(raw: unknown): EmailBisonLeadResult | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  if (id === undefined || id === null) return null;
  const email = typeof record.email === "string" ? record.email : null;
  return { id: String(id), email };
}

/** Upserts a batch of leads by email in one call
 * (`POST /api/leads/create-or-update/multiple`) — the true-upsert endpoint,
 * never the create-only `/api/leads` one (see api-research.md). */
export async function upsertLeadsBulk(
  credentials: EmailBisonCredentials,
  leads: EmailBisonLeadPayload[],
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonLeadResult[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // `existing_lead_behavior` must be sent at the TOP LEVEL of the request
  // body (a sibling of `leads`), per the `/multiple` endpoint's OpenAPI
  // spec — it is not a per-lead field. When absent, EmailBison defaults it
  // to "put" (full replace, wiping fields/custom variables not included in
  // this push), which was the root cause of #144. All leads in a single
  // push share the same behavior, so derive it from the first lead.
  const existingLeadBehavior = leads[0]?.existingLeadBehavior ?? "patch";
  const { status, json } = await requestWithRetry(fetchImpl, credentials, "/api/leads/create-or-update/multiple", {
    existing_lead_behavior: existingLeadBehavior,
    leads: leads.map(toWireLead),
  });
  assertOk(status, json, "lead upsert");
  return extractArray(json)
    .map(toLeadResult)
    .filter((result): result is EmailBisonLeadResult => result !== null);
}

function toCampaign(raw: unknown): EmailBisonCampaign | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  if (id === undefined || id === null || typeof name !== "string") return null;
  // Status is best-effort: the create response includes `status: "draft"`, but
  // whether the LIST endpoint returns per-row status is unconfirmed, so extract
  // it defensively (undefined if absent) rather than requiring it.
  const status = typeof record.status === "string" ? record.status : undefined;
  return { id: String(id), name, ...(status !== undefined ? { status } : {}) };
}

/** Lists campaigns for the workspace (`GET /api/campaigns`), paginated.
 * Pagination metadata is read defensively since the exact envelope shape is
 * unconfirmed against a live token. */
export async function listCampaigns(
  credentials: EmailBisonCredentials,
  page = 1,
  deps: EmailBisonClientDeps = {}
): Promise<ListCampaignsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestGetWithRetry(fetchImpl, credentials, `/api/campaigns?page=${page}`);
  assertOk(status, json, "campaign list");

  const campaigns = extractArray(json)
    .map(toCampaign)
    .filter((campaign): campaign is EmailBisonCampaign => campaign !== null);

  const meta = json && typeof json === "object" ? (json as Record<string, unknown>).meta : null;
  const currentPage = meta && typeof meta === "object" ? Number((meta as Record<string, unknown>).current_page) : NaN;
  const lastPage = meta && typeof meta === "object" ? Number((meta as Record<string, unknown>).last_page) : NaN;
  const hasMore = !Number.isNaN(currentPage) && !Number.isNaN(lastPage) ? currentPage < lastPage : false;

  return { campaigns, page, hasMore };
}

export interface EmailBisonAttachFailure {
  leadId: string;
  reason: string;
}

export interface EmailBisonAttachResult {
  attached: string[];
  failed: EmailBisonAttachFailure[];
}

/** Max concurrent attach-leads calls in flight — mirrors
 * EMAILBISON_PUSH_CONCURRENCY (lib/emailbison/push-to-emailbison.ts). */
const ATTACH_CONCURRENCY = 8;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** EmailBison's stock rejection text for the two-sequences-at-once rule
 * (`POST /api/campaigns/{id}/leads/attach-leads`, no `allow_parallel_sending`)
 * — confirmed live, verbatim: "No leads were added because they are either
 * in other sequences, have previously bounced, or unsubscribed." Bundles
 * three distinct causes into one message, so this can only be used to *flag*
 * the likely cause, not to distinguish which of the three actually applied. */
const IN_OTHER_SEQUENCE_MESSAGE_PATTERN = /other sequences/i;

/** Expands EmailBison's bundled rejection message into an honest explanation
 * when it matches the known three-causes-in-one phrasing, instead of
 * collapsing it to just the sequence-conflict cause. `parallel` is whatever
 * "Allow parallel sending" setting this push actually used:
 *  - When `parallel` was NOT already on, the sequence conflict is still a
 *    live possible cause, so all three causes are listed and the message
 *    points at "Allow parallel sending" as the fix for that one cause.
 *  - When `parallel` WAS already on, EmailBison's own sequence-conflict rule
 *    is already bypassed, so that cause is ruled out — the message says so
 *    and narrows the remaining likely causes to bounced/unsubscribed, which
 *    parallel sending cannot override, rather than re-suggesting a toggle
 *    the caller already had on (issue: a parallel-on push with 756 failures
 *    still told the user to enable it, which was useless and confusing).
 * Falls back to EmailBison's raw message for anything that doesn't match the
 * bundled pattern. */
function describeAttachFailure(message: string, parallel?: boolean): string {
  if (IN_OTHER_SEQUENCE_MESSAGE_PATTERN.test(message)) {
    if (parallel) {
      return `EmailBison rejected this lead (EmailBison's message: "${message}"). Parallel sending was already enabled for this push, so it isn't a sequence conflict — the likely cause is that this lead previously bounced or unsubscribed, or it's already active in this campaign already, neither of which enabling parallel sending overrides.`;
    }
    return `EmailBison rejected this lead for one of a few possible reasons: it's already active in another campaign in this workspace, it's already active in this campaign already, it previously bounced, or it unsubscribed (EmailBison's message: "${message}"). If it's a sequence conflict, use "Allow parallel sending" to add it anyway — that won't help if it bounced, unsubscribed, or is already in this campaign.`;
  }
  return message;
}

/** Attaches leads to a campaign by their EmailBison lead ids
 * (`POST /api/campaigns/{campaign_id}/leads/attach-leads`) — async on
 * EmailBison's side (up to ~5 minutes to sync), so callers should present a
 * successful attach as "queued" rather than immediate membership.
 *
 * Issue #106: sending the whole batch in one call returns a blanket `2xx`
 * even when some leads silently no-op (e.g. a lead already active in another
 * campaign — EmailBison forbids a lead being in two sequences at once). A
 * single-lead call for one of those returns a real `422` with a clear
 * message, confirmed live — so this sends one request per lead (bounded to
 * ATTACH_CONCURRENCY in flight) instead of one request per batch, and
 * reports which lead ids actually attached vs. failed, rather than trusting
 * a single status code for the whole set. `parallel` mirrors Clay's "Allow
 * parallel sending" toggle and maps to the wire field `allow_parallel_sending`
 * — confirmed live (OpenAPI spec + a live attach that produced true dual
 * `in_sequence` membership across two campaigns); the previous `parallel` key
 * was an unconfirmed guess and was silently ignored by EmailBison. Also
 * passed to describeAttachFailure so failure reasons reflect whether this
 * push already had parallel sending on, instead of always suggesting a
 * toggle the caller may have already enabled. */
export async function attachLeadsToCampaign(
  credentials: EmailBisonCredentials,
  campaignId: string,
  leadIds: string[],
  options: { parallel?: boolean } = {},
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonAttachResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const attached: string[] = [];
  const failed: EmailBisonAttachFailure[] = [];

  for (const group of chunkArray(leadIds, ATTACH_CONCURRENCY)) {
    const settled = await Promise.allSettled(
      group.map((leadId) =>
        requestWithRetry(fetchImpl, credentials, `/api/campaigns/${campaignId}/leads/attach-leads`, {
          lead_ids: [leadId],
          ...(options.parallel !== undefined ? { allow_parallel_sending: options.parallel } : {}),
        })
      )
    );

    settled.forEach((result, i) => {
      const leadId = group[i];
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failed.push({ leadId, reason });
        return;
      }

      const { status, json } = result.value;
      const data = json && typeof json === "object" ? (json as Record<string, unknown>).data : null;
      const message = data && typeof data === "object" ? (data as Record<string, unknown>).message : undefined;

      if (status < 200 || status >= 300) {
        const reason = typeof message === "string" ? describeAttachFailure(message, options.parallel) : `EmailBison campaign attach failed with status ${status}: ${JSON.stringify(json)}`;
        failed.push({ leadId, reason });
        return;
      }

      if (data && typeof data === "object" && (data as Record<string, unknown>).success === false) {
        failed.push({ leadId, reason: typeof message === "string" ? describeAttachFailure(message, options.parallel) : "unknown error" });
        return;
      }

      attached.push(leadId);
    });
  }

  return { attached, failed };
}

function toCustomVariable(raw: unknown): EmailBisonCustomVariable | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  if (id === undefined || id === null || typeof name !== "string") return null;
  return { id: String(id), name };
}

/** Safety cap on pages walked by listCustomVariables — guards against an
 * infinite loop if `meta.last_page` is ever malformed/misreported, while
 * staying far above any real workspace's page count (27 vars / 15 per page
 * = 2 pages for the workspace this was confirmed against). */
const CUSTOM_VARIABLES_MAX_PAGES = 100;

/** Lists the workspace's custom variables (`GET /api/custom-variables`) —
 * variable names must already exist before being referenced on a lead
 * upsert, so callers check this before createCustomVariable.
 *
 * Confirmed live: this endpoint is paginated at 15 items/page and ignores
 * `?per_page=`, so a workspace with more than 15 custom variables would be
 * silently truncated to page 1 by a single GET (issue: truncation made
 * ensureCustomVariablesExist in push-to-emailbison.ts think already-existing
 * page-2+ variables were missing). Unlike listCampaigns/listSenderEmails,
 * callers here don't want per-page pagination info — they want the full set
 * — so this walks every page internally via `meta.last_page` and
 * concatenates the results, falling back to just the first page if `meta` is
 * missing/malformed rather than looping forever. */
export async function listCustomVariables(
  credentials: EmailBisonCredentials,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonCustomVariable[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const { status, json } = await requestGetWithRetry(fetchImpl, credentials, "/api/custom-variables");
  assertOk(status, json, "custom-variable list");

  const variables = extractArray(json)
    .map(toCustomVariable)
    .filter((variable): variable is EmailBisonCustomVariable => variable !== null);

  const meta = json && typeof json === "object" ? (json as Record<string, unknown>).meta : null;
  const lastPage = meta && typeof meta === "object" ? Number((meta as Record<string, unknown>).last_page) : NaN;

  // No usable last_page (missing/malformed meta) — trust the single page we
  // already have rather than guessing how many more to fetch.
  if (Number.isNaN(lastPage) || lastPage <= 1) {
    return variables;
  }

  const pagesToFetch = Math.min(lastPage, CUSTOM_VARIABLES_MAX_PAGES);
  for (let page = 2; page <= pagesToFetch; page++) {
    const pageResult = await requestGetWithRetry(fetchImpl, credentials, `/api/custom-variables?page=${page}`);
    assertOk(pageResult.status, pageResult.json, "custom-variable list");
    variables.push(
      ...extractArray(pageResult.json)
        .map(toCustomVariable)
        .filter((variable): variable is EmailBisonCustomVariable => variable !== null)
    );
  }

  return variables;
}

/** Creates a new custom variable by name (`POST /api/custom-variables`) —
 * no auto-create on the lead-write endpoint itself, so the push flow must
 * call this for any name not already returned by listCustomVariables. */
export async function createCustomVariable(
  credentials: EmailBisonCredentials,
  name: string,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonCustomVariable> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestWithRetry(fetchImpl, credentials, "/api/custom-variables", { name });
  assertOk(status, json, "custom-variable create");

  const record = json && typeof json === "object" ? (json as Record<string, unknown>).data ?? json : json;
  const variable = toCustomVariable(record);
  if (!variable) {
    throw new EmailBisonApiError("EmailBison custom-variable create succeeded but returned no variable");
  }
  return variable;
}

/** Creates a new campaign (`POST /api/campaigns`) — confirmed live: `201`
 * with `{ data: { id, name, status: "draft", ... } }`. First step of the
 * end-to-end create-campaign flow (issue #94). */
export async function createCampaign(
  credentials: EmailBisonCredentials,
  name: string,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonCampaign> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestWithRetry(fetchImpl, credentials, "/api/campaigns", { name });
  assertOk(status, json, "campaign create");

  const record = json && typeof json === "object" ? (json as Record<string, unknown>).data ?? json : json;
  const campaign = toCampaign(record);
  if (!campaign) {
    throw new EmailBisonApiError("EmailBison campaign create succeeded but returned no campaign");
  }
  return campaign;
}

export interface EmailBisonSenderEmailTag {
  id: string;
  name: string;
}

export interface EmailBisonSenderEmail {
  id: string;
  name: string;
  email: string;
  /** Connection status as reported by EmailBison (e.g. "Connected") — the
   * `/api/sender-emails` query enum is connected | not_connected |
   * pending_move | pending_deletion, but the list endpoint itself returns a
   * free-form string, so this is read defensively rather than narrowed to a
   * union. `null` when absent. */
  status: string | null;
  warmupEnabled: boolean | null;
  dailyLimit: number | null;
  type: string | null;
  tags: EmailBisonSenderEmailTag[];
}

export interface ListSenderEmailsResult {
  senderEmails: EmailBisonSenderEmail[];
  page: number;
  hasMore: boolean;
}

function toSenderEmailTag(raw: unknown): EmailBisonSenderEmailTag | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  if (id === undefined || id === null || typeof name !== "string") return null;
  return { id: String(id), name };
}

function toSenderEmail(raw: unknown): EmailBisonSenderEmail | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  const email = record.email;
  if (id === undefined || id === null || typeof name !== "string" || typeof email !== "string") return null;

  const status = typeof record.status === "string" ? record.status : null;
  const warmupEnabled = typeof record.warmup_enabled === "boolean" ? record.warmup_enabled : null;
  const dailyLimit = typeof record.daily_limit === "number" ? record.daily_limit : null;
  const type = typeof record.type === "string" ? record.type : null;
  const tags = Array.isArray(record.tags)
    ? record.tags.map(toSenderEmailTag).filter((tag): tag is EmailBisonSenderEmailTag => tag !== null)
    : [];

  return { id: String(id), name, email, status, warmupEnabled, dailyLimit, type, tags };
}

/** Lists the workspace's sender emails (`GET /api/sender-emails`), same
 * paginated envelope as listCampaigns — confirmed live: `200` with
 * `{ data: [{ id, name, email, ... }] }`. Single page; callers that need
 * the full set should use listAllSenderEmails. */
export async function listSenderEmails(
  credentials: EmailBisonCredentials,
  page = 1,
  deps: EmailBisonClientDeps = {}
): Promise<ListSenderEmailsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestGetWithRetry(fetchImpl, credentials, `/api/sender-emails?page=${page}`);
  assertOk(status, json, "sender-email list");

  const senderEmails = extractArray(json)
    .map(toSenderEmail)
    .filter((senderEmail): senderEmail is EmailBisonSenderEmail => senderEmail !== null);

  const meta = json && typeof json === "object" ? (json as Record<string, unknown>).meta : null;
  const currentPage = meta && typeof meta === "object" ? Number((meta as Record<string, unknown>).current_page) : NaN;
  const lastPage = meta && typeof meta === "object" ? Number((meta as Record<string, unknown>).last_page) : NaN;
  const hasMore = !Number.isNaN(currentPage) && !Number.isNaN(lastPage) ? currentPage < lastPage : false;

  return { senderEmails, page, hasMore };
}

/** Safety cap on pages walked by listAllSenderEmails — same rationale as
 * CUSTOM_VARIABLES_MAX_PAGES: guards against an infinite loop on malformed
 * `meta.last_page` while staying far above any real workspace. The
 * sender-emails endpoint paginates at 15/page like custom-variables, so a
 * workspace with >15 mailboxes was silently truncated to page 1 by the
 * single-GET route (the create-campaign picker only ever showed the first
 * ~15 senders). */
const SENDER_EMAILS_MAX_PAGES = 200;

/** Lists ALL of the workspace's sender emails, walking every page via
 * `meta.last_page` and concatenating — the create-campaign picker needs the
 * full set, not one page. Falls back to just the first page if `meta` is
 * missing/malformed rather than looping forever. */
export async function listAllSenderEmails(
  credentials: EmailBisonCredentials,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonSenderEmail[]> {
  const first = await listSenderEmails(credentials, 1, deps);
  const senderEmails = [...first.senderEmails];
  if (!first.hasMore) return senderEmails;

  const fetchImpl = deps.fetchImpl ?? fetch;
  for (let page = 2; page <= SENDER_EMAILS_MAX_PAGES; page++) {
    const { status, json } = await requestGetWithRetry(fetchImpl, credentials, `/api/sender-emails?page=${page}`);
    assertOk(status, json, "sender-email list");

    senderEmails.push(
      ...extractArray(json)
        .map(toSenderEmail)
        .filter((senderEmail): senderEmail is EmailBisonSenderEmail => senderEmail !== null)
    );

    const meta = json && typeof json === "object" ? (json as Record<string, unknown>).meta : null;
    const currentPage = meta && typeof meta === "object" ? Number((meta as Record<string, unknown>).current_page) : NaN;
    const lastPage = meta && typeof meta === "object" ? Number((meta as Record<string, unknown>).last_page) : NaN;
    if (Number.isNaN(currentPage) || Number.isNaN(lastPage) || currentPage >= lastPage) break;
  }

  return senderEmails;
}

export interface EmailBisonWarmupStat {
  id: string;
  warmupScore: number | null;
  /** The warmup-stats endpoint (`/api/warmup/sender-emails`) doesn't return
   * a warmup_enabled field of its own — that lives on the base sender-email
   * record (see EmailBisonSenderEmail.warmupEnabled) — so this is always
   * `null` here; kept on the type for symmetry/future-proofing rather than
   * omitted. */
  warmupEnabled: boolean | null;
  bouncesReceived: number | null;
  bouncesCaused: number | null;
  disabledForBouncing: number | null;
}

function toWarmupStat(raw: unknown): EmailBisonWarmupStat | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  if (id === undefined || id === null) return null;

  const warmupScore = typeof record.warmup_score === "number" ? record.warmup_score : null;
  const bouncesReceived =
    typeof record.warmup_bounces_received_count === "number" ? record.warmup_bounces_received_count : null;
  const bouncesCaused =
    typeof record.warmup_bounces_caused_count === "number" ? record.warmup_bounces_caused_count : null;
  const disabledForBouncing =
    typeof record.warmup_disabled_for_bouncing_count === "number"
      ? record.warmup_disabled_for_bouncing_count
      : null;

  return { id: String(id), warmupScore, warmupEnabled: null, bouncesReceived, bouncesCaused, disabledForBouncing };
}

/** Safety cap on pages walked by listAllWarmupSenderEmails — same rationale
 * as SENDER_EMAILS_MAX_PAGES; this endpoint paginates at 15/page too. */
const WARMUP_SENDER_EMAILS_MAX_PAGES = 200;

/** Lists ALL of the workspace's warmup stats (`GET
 * /api/warmup/sender-emails`), walking every page via `meta.last_page` and
 * concatenating — mirrors listAllSenderEmails exactly, just against the
 * warmup-stats endpoint. Callers join these back to the base sender-email
 * list by `id` to get a per-mailbox warmup score (the "burnt" signal the
 * base `/api/sender-emails` list doesn't carry). Falls back to just the
 * first page if `meta` is missing/malformed rather than looping forever. */
export async function listAllWarmupSenderEmails(
  credentials: EmailBisonCredentials,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonWarmupStat[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const { status, json } = await requestGetWithRetry(fetchImpl, credentials, "/api/warmup/sender-emails");
  assertOk(status, json, "warmup sender-email list");

  const warmupStats = extractArray(json)
    .map(toWarmupStat)
    .filter((stat): stat is EmailBisonWarmupStat => stat !== null);

  const firstMeta = json && typeof json === "object" ? (json as Record<string, unknown>).meta : null;
  const firstCurrentPage =
    firstMeta && typeof firstMeta === "object" ? Number((firstMeta as Record<string, unknown>).current_page) : NaN;
  const firstLastPage =
    firstMeta && typeof firstMeta === "object" ? Number((firstMeta as Record<string, unknown>).last_page) : NaN;
  if (Number.isNaN(firstCurrentPage) || Number.isNaN(firstLastPage) || firstCurrentPage >= firstLastPage) {
    return warmupStats;
  }

  for (let page = 2; page <= WARMUP_SENDER_EMAILS_MAX_PAGES; page++) {
    const pageResult = await requestGetWithRetry(fetchImpl, credentials, `/api/warmup/sender-emails?page=${page}`);
    assertOk(pageResult.status, pageResult.json, "warmup sender-email list");

    warmupStats.push(
      ...extractArray(pageResult.json)
        .map(toWarmupStat)
        .filter((stat): stat is EmailBisonWarmupStat => stat !== null)
    );

    const meta = pageResult.json && typeof pageResult.json === "object" ? (pageResult.json as Record<string, unknown>).meta : null;
    const currentPage = meta && typeof meta === "object" ? Number((meta as Record<string, unknown>).current_page) : NaN;
    const lastPage = meta && typeof meta === "object" ? Number((meta as Record<string, unknown>).last_page) : NaN;
    if (Number.isNaN(currentPage) || Number.isNaN(lastPage) || currentPage >= lastPage) break;
  }

  return warmupStats;
}

/** Attaches sender emails to a campaign (`POST
 * /api/campaigns/{id}/attach-sender-emails`) — confirmed live: `200` with
 * `{ data: { success: true, message } }`. Also confirmed live is a `200`
 * with `{ data: { success: false, message } }` for a semantic failure (e.g.
 * schedule not found), which assertOk alone wouldn't catch. */
export async function attachSenderEmails(
  credentials: EmailBisonCredentials,
  campaignId: string,
  senderEmailIds: string[],
  deps: EmailBisonClientDeps = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestWithRetry(
    fetchImpl,
    credentials,
    `/api/campaigns/${campaignId}/attach-sender-emails`,
    { sender_email_ids: senderEmailIds }
  );
  assertOk(status, json, "sender-email attach");
  assertSuccessBody(json, "sender-email attach");
}

/** Days/window for createCampaignSchedule — camelCase mirror of the wire
 * body's monday..sunday booleans plus start_time/end_time (HH:MM) and
 * timezone. `save_as_template` is always sent as `false`, matching #94's
 * confirmed live request (not exposed as an option here). */
export interface EmailBisonCampaignScheduleInput {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  startTime: string;
  endTime: string;
  timezone: string;
}

export interface EmailBisonCampaignSchedule {
  id: string;
}

function toWireSchedule(schedule: EmailBisonCampaignScheduleInput): Record<string, unknown> {
  return {
    monday: schedule.monday,
    tuesday: schedule.tuesday,
    wednesday: schedule.wednesday,
    thursday: schedule.thursday,
    friday: schedule.friday,
    saturday: schedule.saturday,
    sunday: schedule.sunday,
    start_time: schedule.startTime,
    end_time: schedule.endTime,
    timezone: schedule.timezone,
    save_as_template: false,
  };
}

/** Creates a campaign's sending schedule (`POST
 * /api/campaigns/{id}/schedule`) — confirmed live: `201` with the persisted
 * schedule object. Subject to the same `{ data: { success: false } }`-on-2xx
 * failure shape as attachSenderEmails. */
export async function createCampaignSchedule(
  credentials: EmailBisonCredentials,
  campaignId: string,
  schedule: EmailBisonCampaignScheduleInput,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonCampaignSchedule> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestWithRetry(
    fetchImpl,
    credentials,
    `/api/campaigns/${campaignId}/schedule`,
    toWireSchedule(schedule)
  );
  assertOk(status, json, "campaign schedule create");
  assertSuccessBody(json, "campaign schedule create");

  const record = json && typeof json === "object" ? (json as Record<string, unknown>).data ?? json : json;
  const id =
    record && typeof record === "object" ? (record as Record<string, unknown>).id : undefined;
  if (id === undefined || id === null) {
    throw new EmailBisonApiError("EmailBison campaign schedule create succeeded but returned no schedule id");
  }
  return { id: String(id) };
}

/** One sequence step for createSequenceSteps — camelCase mirror of the wire
 * body's email_subject/email_body/wait_in_days/thread_reply. Split-test
 * variant fields are NOT part of this shape — createSequenceSteps only creates
 * plain steps. An extra split-test variant is created the same way (its own
 * createSequenceSteps call, a single-element array appended to the campaign's
 * one sequence), and then linked to its base step in a single whole-sequence
 * PUT via updateSequenceVariants below. See lib/emailbison/campaigns.ts's
 * createEmailBisonCampaign for the orchestration. */
export interface EmailBisonSequenceStepInput {
  emailSubject: string;
  emailBody: string;
  waitInDays: number;
  threadReply: boolean;
}

export interface EmailBisonSequenceStepResult {
  id: string;
}

export interface EmailBisonSequenceResult {
  id: string;
  steps: EmailBisonSequenceStepResult[];
}

function toWireSequenceStep(step: EmailBisonSequenceStepInput): Record<string, unknown> {
  return {
    email_subject: step.emailSubject,
    email_body: step.emailBody,
    wait_in_days: step.waitInDays,
    thread_reply: step.threadReply,
  };
}

/** Creates sequence steps on a campaign (`POST
 * /api/campaigns/{id}/sequence-steps`) — confirmed live: `201`/`200` with the
 * persisted sequence + step ids. `id` in the result is the **sequence** id
 * (== `campaign.sequence_id`) — the exact id updateSequenceVariants' PUT path
 * needs. There is only ever one sequence per campaign: a later call appends to
 * it rather than creating a new one, and `steps` then holds **all** of the
 * sequence's steps with the newly-created one **last** (not `[0]`), so a
 * caller adding a variant reads the new step id from the end of `steps`.
 * Subject to the same `{ data: { success: false } }`-on-2xx failure shape as
 * attachSenderEmails. */
export async function createSequenceSteps(
  credentials: EmailBisonCredentials,
  campaignId: string,
  title: string,
  steps: EmailBisonSequenceStepInput[],
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonSequenceResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestWithRetry(
    fetchImpl,
    credentials,
    `/api/campaigns/${campaignId}/sequence-steps`,
    { title, sequence_steps: steps.map(toWireSequenceStep) }
  );
  assertOk(status, json, "sequence-steps create");
  assertSuccessBody(json, "sequence-steps create");

  const record = json && typeof json === "object" ? (json as Record<string, unknown>).data ?? json : json;
  const data = record && typeof record === "object" ? (record as Record<string, unknown>) : null;
  const id = data ? data.id : undefined;
  if (id === undefined || id === null) {
    throw new EmailBisonApiError("EmailBison sequence-steps create succeeded but returned no sequence id");
  }
  const rawSteps = data && Array.isArray(data.sequence_steps) ? data.sequence_steps : [];
  const resultSteps = rawSteps
    .map((raw): EmailBisonSequenceStepResult | null => {
      if (!raw || typeof raw !== "object") return null;
      const stepId = (raw as Record<string, unknown>).id;
      return stepId === undefined || stepId === null ? null : { id: String(stepId) };
    })
    .filter((step): step is EmailBisonSequenceStepResult => step !== null);

  return { id: String(id), steps: resultSteps };
}

/** Full detail of one persisted sequence step, as read back from the v1.1
 * sequence-steps GET — everything updateSequenceVariants' PUT must echo. The
 * API returns `order`/`wait_in_days` as either a number or a numeric string
 * depending on the endpoint, so both are coerced to numbers here. `order` is
 * EmailBison-assigned and must be echoed unchanged and kept unique per step
 * (a duplicate order 422s "duplicate value"). */
export interface EmailBisonSequenceStepDetail {
  id: string;
  emailSubject: string;
  order: number;
  emailBody: string;
  waitInDays: number;
  threadReply: boolean;
}

export interface EmailBisonSequenceStepsDetail {
  sequenceId: string;
  steps: EmailBisonSequenceStepDetail[];
}

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toSequenceStepDetail(raw: unknown): EmailBisonSequenceStepDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  if (id === undefined || id === null) return null;
  return {
    id: String(id),
    emailSubject: typeof record.email_subject === "string" ? record.email_subject : "",
    order: toNumber(record.order),
    emailBody: typeof record.email_body === "string" ? record.email_body : "",
    waitInDays: toNumber(record.wait_in_days),
    threadReply: typeof record.thread_reply === "boolean" ? record.thread_reply : false,
  };
}

/** Reads a campaign's full sequence (`GET
 * /api/campaigns/v1.1/{campaign_id}/sequence-steps`) — returns the sequence id
 * plus every step with its EmailBison-assigned `order`. The v1.1 GET is the
 * authoritative source of each step's `order`, which updateSequenceVariants
 * must echo on the whole-sequence PUT that links split-test variants. */
export async function getSequenceSteps(
  credentials: EmailBisonCredentials,
  campaignId: string,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonSequenceStepsDetail> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestGetWithRetry(
    fetchImpl,
    credentials,
    `/api/campaigns/v1.1/${campaignId}/sequence-steps`
  );
  assertOk(status, json, "sequence-steps read");

  const data = json && typeof json === "object" ? (json as Record<string, unknown>).data : null;
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const sequenceId = record ? record.sequence_id : undefined;
  if (sequenceId === undefined || sequenceId === null) {
    throw new EmailBisonApiError("EmailBison sequence-steps read returned no sequence id");
  }
  const rawSteps = record && Array.isArray(record.sequence_steps) ? record.sequence_steps : [];
  const steps = rawSteps
    .map(toSequenceStepDetail)
    .filter((step): step is EmailBisonSequenceStepDetail => step !== null);

  return { sequenceId: String(sequenceId), steps };
}

/** One step in an updateSequenceVariants PUT body: an
 * EmailBisonSequenceStepDetail (echoed verbatim from getSequenceSteps) plus its
 * split-test role. A base step is `variant: false`; an extra ("B", "C", …)
 * variant is `variant: true` with `variantFromStepId` set to the id of the base
 * step it splits from (the API requires it whenever `variant` is true).
 * EmailBison has no letter concept — multiple variants of one base step are all
 * `variant: true` pointing at the same base id, distinguished only by `order`. */
export interface EmailBisonSequenceVariantStep extends EmailBisonSequenceStepDetail {
  variant: boolean;
  variantFromStepId?: string;
}

function toWireVariantStep(step: EmailBisonSequenceVariantStep): Record<string, unknown> {
  return {
    id: toNumber(step.id),
    email_subject: step.emailSubject,
    order: step.order,
    email_body: step.emailBody,
    wait_in_days: step.waitInDays,
    thread_reply: step.threadReply,
    variant: step.variant,
    ...(step.variant && step.variantFromStepId !== undefined
      ? { variant_from_step_id: toNumber(step.variantFromStepId) }
      : {}),
  };
}

/** Links split-test variants by PUTting the **whole** sequence to the v1.1
 * endpoint (`PUT /api/campaigns/v1.1/sequence-steps/{sequenceId}`, where
 * `sequenceId` is `campaign.sequence_id`) — the single, live-verified way to
 * attach variants (issue #143). Every step is echoed with its id/subject/order/
 * body/wait; variant steps additionally carry `variant: true` +
 * `variant_from_step_id`. One PUT links all variants at once, so the caller
 * builds the full step array first (see createEmailBisonCampaign). Subject to
 * the same `{ data: { success: false } }`-on-2xx failure shape as
 * attachSenderEmails. */
export async function updateSequenceVariants(
  credentials: EmailBisonCredentials,
  sequenceId: string,
  title: string,
  steps: EmailBisonSequenceVariantStep[],
  deps: EmailBisonClientDeps = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestPutWithRetry(
    fetchImpl,
    credentials,
    `/api/campaigns/v1.1/sequence-steps/${sequenceId}`,
    { title, sequence_steps: steps.map(toWireVariantStep) }
  );
  assertOk(status, json, "sequence-step variant link");
  assertSuccessBody(json, "sequence-step variant link");
}

/** Resumes a paused/draft campaign, starting real sending (`PATCH
 * /api/campaigns/{id}/resume`) — not yet verified live (deliberately not
 * exercised during #94's verification pass); implemented with the same
 * write pattern as the confirmed calls pending a separate live-verification
 * ticket. Subject to the same `{ data: { success: false } }`-on-2xx failure
 * shape as attachSenderEmails. */
export async function resumeCampaign(
  credentials: EmailBisonCredentials,
  campaignId: string,
  deps: EmailBisonClientDeps = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestPatchWithRetry(fetchImpl, credentials, `/api/campaigns/${campaignId}/resume`);
  assertOk(status, json, "campaign resume");
  assertSuccessBody(json, "campaign resume");
}
