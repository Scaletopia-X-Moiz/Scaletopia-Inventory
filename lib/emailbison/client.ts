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
 * the workspace's base URL (e.g. "https://dedi.emailbison.com") rather than a
 * numeric id — the base-URL-per-workspace scheme is unconfirmed against a
 * live token (api-research.md), so this is a best-effort read of
 * `emailbison_workspace_id` until that's verified. */
async function requestWithMethodRetry(
  fetchImpl: typeof fetch,
  credentials: EmailBisonCredentials,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Promise<RawResponse> {
  let attempt = 0;
  for (;;) {
    let resp: Response;
    try {
      resp = await fetchImpl(`${credentials.workspaceId}${path}`, {
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

function assertOk(status: number, json: unknown, action: string): void {
  if (status < 200 || status >= 300) {
    throw new EmailBisonApiError(`EmailBison ${action} failed with status ${status}: ${JSON.stringify(json)}`, status);
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

/** Attaches leads to a campaign by their EmailBison lead ids
 * (`POST /api/campaigns/{campaign_id}/leads/attach-leads`) — async on
 * EmailBison's side (up to ~5 minutes to sync), so callers should present
 * this as "queued" rather than immediate membership. `parallel` mirrors
 * Clay's "Allow parallel sending" toggle; wire field name is a best-effort
 * guess pending a live-token check. */
export async function attachLeadsToCampaign(
  credentials: EmailBisonCredentials,
  campaignId: string,
  leadIds: string[],
  options: { parallel?: boolean } = {},
  deps: EmailBisonClientDeps = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestWithRetry(
    fetchImpl,
    credentials,
    `/api/campaigns/${campaignId}/leads/attach-leads`,
    {
      lead_ids: leadIds,
      ...(options.parallel !== undefined ? { parallel: options.parallel } : {}),
    }
  );
  assertOk(status, json, "campaign attach");
}

function toCustomVariable(raw: unknown): EmailBisonCustomVariable | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const name = record.name;
  if (id === undefined || id === null || typeof name !== "string") return null;
  return { id: String(id), name };
}

/** Lists the workspace's custom variables (`GET /api/custom-variables`) —
 * variable names must already exist before being referenced on a lead
 * upsert, so callers check this before createCustomVariable. */
export async function listCustomVariables(
  credentials: EmailBisonCredentials,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonCustomVariable[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestGetWithRetry(fetchImpl, credentials, "/api/custom-variables");
  assertOk(status, json, "custom-variable list");
  return extractArray(json)
    .map(toCustomVariable)
    .filter((variable): variable is EmailBisonCustomVariable => variable !== null);
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
