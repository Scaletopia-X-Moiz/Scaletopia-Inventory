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
  method: "GET" | "POST" | "PATCH",
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
 * into the snake_case field names confirmed in api-research.md
 * (email/first_name/last_name/company_name/title/phone/website/
 * custom_variables). `existing_lead_behavior` is NOT one of those confirmed
 * fields or one of api-research.md's two "Still open" items — it's our own
 * unverified guess at how to wire up the "Existing Lead Behavior"
 * (PATCH-vs-PUT) control Clay's UI surfaces, since the research doc never
 * pins down a body-field name for it. Needs the same live-token check as the
 * "Still open" items before shipping. */
function toWireLead(lead: EmailBisonLeadPayload): Record<string, unknown> {
  return {
    email: lead.email,
    first_name: lead.firstName,
    last_name: lead.lastName,
    company_name: lead.companyName,
    title: lead.title,
    phone: lead.phone,
    website: lead.website,
    existing_lead_behavior: lead.existingLeadBehavior,
    custom_variables: lead.customVariables.map(({ name, value }) => ({ name, value })),
  };
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
  const { status, json } = await requestWithRetry(fetchImpl, credentials, "/api/leads/create-or-update/multiple", {
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
  return { id: String(id), name };
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
 * parallel sending" toggle; wire field name is a best-effort guess pending a
 * live-token check. */
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
          ...(options.parallel !== undefined ? { parallel: options.parallel } : {}),
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
      if (status < 200 || status >= 300) {
        failed.push({ leadId, reason: `EmailBison campaign attach failed with status ${status}: ${JSON.stringify(json)}` });
        return;
      }

      const data = json && typeof json === "object" ? (json as Record<string, unknown>).data : null;
      if (data && typeof data === "object" && (data as Record<string, unknown>).success === false) {
        const message = (data as Record<string, unknown>).message;
        failed.push({ leadId, reason: typeof message === "string" ? message : "unknown error" });
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

export interface EmailBisonSenderEmail {
  id: string;
  name: string;
  email: string;
}

export interface ListSenderEmailsResult {
  senderEmails: EmailBisonSenderEmail[];
  page: number;
  hasMore: boolean;
}

function toSenderEmail(raw: unknown): EmailBisonSenderEmail | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  const email = record.email;
  if (id === undefined || id === null || typeof name !== "string" || typeof email !== "string") return null;
  return { id: String(id), name, email };
}

/** Lists the workspace's sender emails (`GET /api/sender-emails`), same
 * paginated envelope as listCampaigns — confirmed live: `200` with
 * `{ data: [{ id, name, email, ... }] }`. */
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
 * body's email_subject/email_body/wait_in_days/thread_reply.
 * `variant`/`variant_from_step` are out of scope per issue #96. */
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

/** Creates a campaign's sequence and its steps in one call (`POST
 * /api/campaigns/{id}/sequence-steps`) — confirmed live: `201` with the
 * persisted sequence + step ids. Subject to the same `{ data: { success:
 * false } }`-on-2xx failure shape as attachSenderEmails. */
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
