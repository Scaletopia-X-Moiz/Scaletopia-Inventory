import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  getPeopleForEmailBison,
  getPeopleForEmailBisonByCompanyFilters,
  type EmailBisonPushCandidate,
} from "@/lib/data/people";
import type { PersonListFilters } from "@/lib/data/people";
import type { CompanyListFilters } from "@/lib/data/companies";
import {
  upsertLeadsBulk,
  listCustomVariables,
  createCustomVariable,
  attachLeadsToCampaign,
  type EmailBisonLeadResult,
} from "@/lib/emailbison/client";
import { buildEmailBisonLeadPayload } from "@/lib/emailbison/lead-payload";
import type { ClientRow } from "@/lib/data/clients";
import type { EmailBisonCredentials, EmailBisonCustomVariableEntry } from "@/lib/emailbison/types";

const PLATFORM = "emailbison";

/** Leads per upsertLeadsBulk call — mirrors IN_CHUNK (lib/clay/push-to-clay.ts),
 * a request-size cap rather than a rate-limit concern. */
export const EMAILBISON_CHUNK_SIZE = 200;
/** Concurrent upsertLeadsBulk calls in flight — mirrors CLAY_CONCURRENCY. */
export const EMAILBISON_PUSH_CONCURRENCY = 8;

export interface EmailBisonPushResult {
  total_matched: number;
  pushed: number;
  errors: number;
  /** Display names of people whose push failed, one per failed record. */
  failed_people: string[];
}

export interface EmailBisonPushProgress {
  phase: "resolving" | "pushing" | "done";
  done: number;
  total: number;
  pushed: number;
  errors: number;
}

export interface RunEmailBisonPushDeps {
  fetchImpl?: typeof fetch;
  onProgress?: (p: EmailBisonPushProgress) => void;
  /** Manually-entered custom-variable name/value pairs (issue #52's panel),
   * carried onto every lead in the push. */
  customVariables?: EmailBisonCustomVariableEntry[];
  /** Partial-update vs full-replace when the lead already exists. Defaults to
   * "patch" per issue #52. */
  existingLeadBehavior?: "patch" | "put";
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Ensures every custom-variable name referenced by `entries` exists in the
 * workspace, creating any that are missing. Runs once per push, ahead of the
 * batch upsert — not once per person, since the names are the same for every
 * lead in the push. */
async function ensureCustomVariablesExist(
  credentials: EmailBisonCredentials,
  entries: EmailBisonCustomVariableEntry[],
  fetchImpl: typeof fetch
): Promise<void> {
  const names = Array.from(new Set(entries.map((e) => e.name)));
  if (names.length === 0) return;

  const existing = await listCustomVariables(credentials, { fetchImpl });
  const existingNames = new Set(existing.map((v) => v.name));
  const missing = names.filter((name) => !existingNames.has(name));

  await Promise.all(missing.map((name) => createCustomVariable(credentials, name, { fetchImpl })));
}

interface FailedRecord {
  id: string;
  name: string | null;
  error: string;
}

interface PushOutcome {
  candidate: EmailBisonPushCandidate;
  leadId: string;
}

interface ChunkResult {
  pushed: PushOutcome[];
  failed: FailedRecord[];
}

/** Upserts one chunk (<= EMAILBISON_CHUNK_SIZE) of candidates in a single
 * upsertLeadsBulk call. A candidate with no email can never resolve to an
 * EmailBison lead (leads are upserted by email) and is failed without an API
 * call; a candidate whose email isn't echoed back in the response is treated
 * as failed too. If the bulk call itself throws, every candidate in this
 * chunk fails — but other chunks (and other candidates) are unaffected,
 * since chunks are run through Promise.allSettled by the caller. */
async function pushChunk(
  candidates: EmailBisonPushCandidate[],
  credentials: EmailBisonCredentials,
  customVariables: EmailBisonCustomVariableEntry[],
  existingLeadBehavior: "patch" | "put",
  fetchImpl: typeof fetch
): Promise<ChunkResult> {
  const withEmail = candidates.filter((c) => c.record.email);
  const withoutEmail = candidates.filter((c) => !c.record.email);

  const failed: FailedRecord[] = withoutEmail.map((c) => ({
    id: c.id,
    name: c.displayName,
    error: "no email on record — EmailBison upserts leads by email",
  }));

  if (withEmail.length === 0) {
    return { pushed: [], failed };
  }

  let results: EmailBisonLeadResult[];
  try {
    results = await upsertLeadsBulk(
      credentials,
      withEmail.map((c) => buildEmailBisonLeadPayload(c.record, customVariables, existingLeadBehavior)),
      { fetchImpl }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const c of withEmail) {
      failed.push({ id: c.id, name: c.displayName, error: message });
    }
    return { pushed: [], failed };
  }

  const byEmail = new Map(
    results.filter((r): r is EmailBisonLeadResult & { email: string } => r.email !== null).map((r) => [r.email, r])
  );

  const pushed: PushOutcome[] = [];
  for (const c of withEmail) {
    const result = c.record.email ? byEmail.get(c.record.email) : undefined;
    if (result) {
      pushed.push({ candidate: c, leadId: result.id });
    } else {
      failed.push({
        id: c.id,
        name: c.displayName,
        error: "not returned by EmailBison lead upsert",
      });
    }
  }

  return { pushed, failed };
}

/** Writes/upserts a platform_pushes row per successful upsert, keyed on
 * (person_id, client_id, platform) — a prior push row is overwritten with the
 * latest lead id rather than causing a conflict — then flips the person's
 * pushed_to_emailbison flag, same two-write pattern as lib/ghl/push-to-ghl.ts's
 * pushOne. A write failure downgrades that candidate from pushed to failed
 * without touching the others. */
async function writePushRows(
  outcomes: PushOutcome[],
  client: ClientRow
): Promise<{ written: PushOutcome[]; failed: FailedRecord[] }> {
  if (outcomes.length === 0) return { written: [], failed: [] };

  const pushedAt = new Date().toISOString();
  const settled = await Promise.allSettled(
    outcomes.map(async (outcome) => {
      const { error: pushError } = await supabaseAdmin.from("platform_pushes").upsert(
        {
          person_id: outcome.candidate.id,
          client_id: client.id,
          platform: PLATFORM,
          platform_contact_id: outcome.leadId,
          pushed_at: pushedAt,
        },
        { onConflict: "person_id,client_id,platform" }
      );
      if (pushError) throw pushError;

      const { error: personError } = await supabaseAdmin
        .from("people")
        .update({ pushed_to_emailbison: true, pushed_to_emailbison_at: pushedAt })
        .eq("id", outcome.candidate.id);
      if (personError) throw personError;

      return outcome;
    })
  );

  const written: PushOutcome[] = [];
  const failed: FailedRecord[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      written.push(result.value);
    } else {
      const outcome = outcomes[i];
      failed.push({
        id: outcome.candidate.id,
        name: outcome.candidate.displayName,
        error: String(result.reason),
      });
    }
  });
  return { written, failed };
}

interface EmailBisonEntity<TFilters> {
  /** Discriminates which trigger this run came from (people vs companies). */
  label: string;
  /** Resolves the current filtered view into push candidates. */
  loadRecords: (filters: TFilters) => Promise<EmailBisonPushCandidate[]>;
}

interface WorkspaceUpsertOutcome {
  /** EmailBison lead id per successfully-upserted-and-written person. */
  leadIdByPersonId: Map<string, string>;
  pushed: number;
  errors: number;
  failed_people: string[];
}

/** Upserts `candidates` as EmailBison leads in EMAILBISON_CHUNK_SIZE-sized
 * batches, EMAILBISON_PUSH_CONCURRENCY chunks in flight at a time via
 * Promise.allSettled, writing back a platform_pushes row per success — the
 * shared core of "Add to EmailBison" (runEmailBisonAddToWorkspace) and the
 * add-to-workspace fallback inside "Add to Campaign"
 * (runEmailBisonAddToCampaign). A failed chunk (or a failed per-record
 * write-back) never aborts the rest of the batch. Callers own
 * ensureCustomVariablesExist and progress reporting around this call. */
async function upsertCandidatesToWorkspace(
  candidates: EmailBisonPushCandidate[],
  label: string,
  client: ClientRow,
  credentials: EmailBisonCredentials,
  customVariables: EmailBisonCustomVariableEntry[],
  existingLeadBehavior: "patch" | "put",
  fetchImpl: typeof fetch,
  onChunkGroupDone?: (done: number, pushed: number, errors: number) => void
): Promise<WorkspaceUpsertOutcome> {
  const leadIdByPersonId = new Map<string, string>();
  let pushed = 0;
  let errors = 0;
  let done = 0;
  const failed_people: string[] = [];

  const chunks = chunk(candidates, EMAILBISON_CHUNK_SIZE);

  for (const group of chunk(chunks, EMAILBISON_PUSH_CONCURRENCY)) {
    const settled = await Promise.allSettled(
      group.map((chunkCandidates) =>
        pushChunk(chunkCandidates, credentials, customVariables, existingLeadBehavior, fetchImpl)
      )
    );

    for (let i = 0; i < settled.length; i++) {
      const chunkCandidates = group[i];
      const outcome = settled[i];
      done += chunkCandidates.length;

      if (outcome.status === "rejected") {
        errors += chunkCandidates.length;
        for (const c of chunkCandidates) {
          failed_people.push(c.displayName || "unknown");
        }
        console.error(`EmailBison ${label} push: chunk failed: ${String(outcome.reason)}`);
        continue;
      }

      const { written, failed: writeFailed } = await writePushRows(outcome.value.pushed, client);
      pushed += written.length;
      for (const w of written) {
        leadIdByPersonId.set(w.candidate.id, w.leadId);
      }

      for (const f of [...outcome.value.failed, ...writeFailed]) {
        errors++;
        failed_people.push(f.name || "unknown");
        console.error(`EmailBison ${label} push: failed for person ${f.id} (${f.name ?? "unknown"}): ${f.error}`);
      }
    }

    onChunkGroupDone?.(done, pushed, errors);
  }

  return { leadIdByPersonId, pushed, errors, failed_people };
}

/** Creates or updates every candidate in the current filtered view as an
 * EmailBison lead ("Add to EmailBison", ADR 0003) — never attaches to a
 * campaign, that's the separate "Add to Campaign" action.
 *
 * Every custom-variable name referenced by `deps.customVariables` is ensured
 * to exist in the workspace once, up front. */
async function runEmailBisonAddToWorkspace<TFilters>(
  entity: EmailBisonEntity<TFilters>,
  filters: TFilters,
  client: ClientRow,
  deps: RunEmailBisonPushDeps = {}
): Promise<EmailBisonPushResult> {
  if (!client.emailbisonApiKey || !client.emailbisonWorkspaceId) {
    throw new Error(`Client "${client.name}" has no EmailBison credentials configured`);
  }

  const credentials: EmailBisonCredentials = {
    apiKey: client.emailbisonApiKey,
    workspaceId: client.emailbisonWorkspaceId,
  };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const onProgress = deps.onProgress;
  const customVariables = deps.customVariables ?? [];
  const existingLeadBehavior = deps.existingLeadBehavior ?? "patch";

  onProgress?.({ phase: "resolving", done: 0, total: 0, pushed: 0, errors: 0 });

  const candidates = await entity.loadRecords(filters);
  const total_matched = candidates.length;

  if (total_matched === 0) {
    onProgress?.({ phase: "done", done: 0, total: 0, pushed: 0, errors: 0 });
    return { total_matched: 0, pushed: 0, errors: 0, failed_people: [] };
  }

  await ensureCustomVariablesExist(credentials, customVariables, fetchImpl);

  onProgress?.({ phase: "pushing", done: 0, total: candidates.length, pushed: 0, errors: 0 });

  const { pushed, errors, failed_people } = await upsertCandidatesToWorkspace(
    candidates,
    entity.label,
    client,
    credentials,
    customVariables,
    existingLeadBehavior,
    fetchImpl,
    (done, chunkPushed, chunkErrors) =>
      onProgress?.({ phase: "pushing", done, total: candidates.length, pushed: chunkPushed, errors: chunkErrors })
  );

  onProgress?.({ phase: "done", done: candidates.length, total: candidates.length, pushed, errors });

  return { total_matched, pushed, errors, failed_people };
}

/** Add to EmailBison, triggered from the People table. */
export function runPeopleAddToEmailBison(
  filters: PersonListFilters,
  client: ClientRow,
  deps: RunEmailBisonPushDeps = {}
): Promise<EmailBisonPushResult> {
  return runEmailBisonAddToWorkspace(
    { label: "people", loadRecords: getPeopleForEmailBison },
    filters,
    client,
    deps
  );
}

/** Add to EmailBison, triggered from the Companies table — resolves to every
 * Person linked to the matching Companies (there is no company-level
 * EmailBison object, ADR 0003). */
export function runCompaniesAddToEmailBison(
  filters: CompanyListFilters,
  client: ClientRow,
  deps: RunEmailBisonPushDeps = {}
): Promise<EmailBisonPushResult> {
  return runEmailBisonAddToWorkspace(
    { label: "companies", loadRecords: getPeopleForEmailBisonByCompanyFilters },
    filters,
    client,
    deps
  );
}

export interface EmailBisonCampaignPushResult {
  total_matched: number;
  attached: number;
  errors: number;
  /** Display names of people whose add-to-workspace step or campaign attach
   * failed, one per failed record. */
  failed_people: string[];
}

export interface EmailBisonCampaignPushProgress {
  phase: "resolving" | "adding-to-workspace" | "attaching" | "done";
  done: number;
  total: number;
  attached: number;
  errors: number;
}

/** `customVariables`/`existingLeadBehavior` are only used for candidates that
 * need the add-to-workspace step run first (no prior platform_pushes row) —
 * same fields as RunEmailBisonPushDeps, `onProgress` just reports a different
 * shape (campaign phases, not workspace-push phases). */
export interface RunEmailBisonCampaignPushDeps extends Omit<RunEmailBisonPushDeps, "onProgress"> {
  onProgress?: (p: EmailBisonCampaignPushProgress) => void;
  /** "Allow parallel sending" toggle, passed straight through to
   * attachLeadsToCampaign's `parallel` option. Defaults to sequential when
   * omitted. */
  parallel?: boolean;
}

/** Attaches every candidate in the current filtered view to `campaignId`
 * ("Add to Campaign", ADR 0003). For any candidate with no prior
 * platform_pushes row (or one missing a platform_contact_id), the
 * add-to-workspace step runs first to obtain a lead id — same
 * ensure-custom-variables + chunked-upsert + write-back logic as
 * runEmailBisonAddToWorkspace, just scoped to the subset that needs it.
 * Every resolvable lead id (pre-existing or freshly obtained) is attached to
 * the campaign in a single attachLeadsToCampaign call; on success each
 * attached person's platform_pushes row gets campaign_tag (repurposed to
 * hold the campaign id, matching GHL's tag column) and pushed_at updated. A
 * failed attach call fails every candidate that would have been attached,
 * without touching the workspace-upsert results already written. */
async function runEmailBisonAddToCampaign<TFilters>(
  entity: EmailBisonEntity<TFilters>,
  filters: TFilters,
  client: ClientRow,
  campaignId: string,
  deps: RunEmailBisonCampaignPushDeps = {}
): Promise<EmailBisonCampaignPushResult> {
  if (!client.emailbisonApiKey || !client.emailbisonWorkspaceId) {
    throw new Error(`Client "${client.name}" has no EmailBison credentials configured`);
  }

  const credentials: EmailBisonCredentials = {
    apiKey: client.emailbisonApiKey,
    workspaceId: client.emailbisonWorkspaceId,
  };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const onProgress = deps.onProgress;
  const customVariables = deps.customVariables ?? [];
  const existingLeadBehavior = deps.existingLeadBehavior ?? "patch";

  onProgress?.({ phase: "resolving", done: 0, total: 0, attached: 0, errors: 0 });

  const candidates = await entity.loadRecords(filters);
  const total_matched = candidates.length;

  if (total_matched === 0) {
    onProgress?.({ phase: "done", done: 0, total: 0, attached: 0, errors: 0 });
    return { total_matched: 0, attached: 0, errors: 0, failed_people: [] };
  }

  const { data: existingRows, error: lookupError } = await supabaseAdmin
    .from("platform_pushes")
    .select("person_id,platform_contact_id")
    .eq("client_id", client.id)
    .eq("platform", PLATFORM)
    .in(
      "person_id",
      candidates.map((c) => c.id)
    );
  if (lookupError) throw lookupError;

  const leadIdByPersonId = new Map<string, string>();
  for (const row of existingRows ?? []) {
    if (row.platform_contact_id) {
      leadIdByPersonId.set(row.person_id as string, row.platform_contact_id as string);
    }
  }

  const needsUpsert = candidates.filter((c) => !leadIdByPersonId.has(c.id));

  let errors = 0;
  const failed_people: string[] = [];

  if (needsUpsert.length > 0) {
    onProgress?.({ phase: "adding-to-workspace", done: 0, total: needsUpsert.length, attached: 0, errors: 0 });
    await ensureCustomVariablesExist(credentials, customVariables, fetchImpl);

    const upsertOutcome = await upsertCandidatesToWorkspace(
      needsUpsert,
      entity.label,
      client,
      credentials,
      customVariables,
      existingLeadBehavior,
      fetchImpl,
      (done) => onProgress?.({ phase: "adding-to-workspace", done, total: needsUpsert.length, attached: 0, errors: 0 })
    );
    for (const [personId, leadId] of upsertOutcome.leadIdByPersonId) {
      leadIdByPersonId.set(personId, leadId);
    }
    errors += upsertOutcome.errors;
    failed_people.push(...upsertOutcome.failed_people);
  }

  const attachable = candidates.filter((c) => leadIdByPersonId.has(c.id));

  if (attachable.length === 0) {
    onProgress?.({ phase: "done", done: total_matched, total: total_matched, attached: 0, errors });
    return { total_matched, attached: 0, errors, failed_people };
  }

  onProgress?.({ phase: "attaching", done: 0, total: attachable.length, attached: 0, errors });

  let attached = 0;
  try {
    await attachLeadsToCampaign(
      credentials,
      campaignId,
      attachable.map((c) => leadIdByPersonId.get(c.id)!),
      { parallel: deps.parallel },
      { fetchImpl }
    );

    const pushedAt = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from("platform_pushes")
      .update({ campaign_tag: campaignId, pushed_at: pushedAt })
      .eq("client_id", client.id)
      .eq("platform", PLATFORM)
      .in(
        "person_id",
        attachable.map((c) => c.id)
      );
    if (updateError) throw updateError;

    attached = attachable.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors += attachable.length;
    for (const c of attachable) failed_people.push(c.displayName || "unknown");
    console.error(`EmailBison ${entity.label} add-to-campaign: attach failed: ${message}`);
  }

  onProgress?.({ phase: "done", done: total_matched, total: total_matched, attached, errors });

  return { total_matched, attached, errors, failed_people };
}

/** Add to Campaign, triggered from the People table. */
export function runPeopleAddToCampaign(
  filters: PersonListFilters,
  client: ClientRow,
  campaignId: string,
  deps: RunEmailBisonCampaignPushDeps = {}
): Promise<EmailBisonCampaignPushResult> {
  return runEmailBisonAddToCampaign(
    { label: "people", loadRecords: getPeopleForEmailBison },
    filters,
    client,
    campaignId,
    deps
  );
}

/** Add to Campaign, triggered from the Companies table — resolves to every
 * Person linked to the matching Companies (there is no company-level
 * EmailBison object, ADR 0003). */
export function runCompaniesAddToCampaign(
  filters: CompanyListFilters,
  client: ClientRow,
  campaignId: string,
  deps: RunEmailBisonCampaignPushDeps = {}
): Promise<EmailBisonCampaignPushResult> {
  return runEmailBisonAddToCampaign(
    { label: "companies", loadRecords: getPeopleForEmailBisonByCompanyFilters },
    filters,
    client,
    campaignId,
    deps
  );
}
