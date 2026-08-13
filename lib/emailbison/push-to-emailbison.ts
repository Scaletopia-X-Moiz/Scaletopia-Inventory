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
import { buildEmailBisonLeadPayload, resolveCustomVariables } from "@/lib/emailbison/lead-payload";
import type { ClientRow } from "@/lib/data/clients";
import type {
  EmailBisonCredentials,
  EmailBisonCustomVariableEntry,
  EmailBisonStandardFieldMapping,
} from "@/lib/emailbison/types";
import type { SessionUser } from "@/lib/auth/dal";

const PLATFORM = "emailbison";

/** Leads per upsertLeadsBulk call — mirrors IN_CHUNK (lib/clay/push-to-clay.ts),
 * a request-size cap rather than a rate-limit concern. */
export const EMAILBISON_CHUNK_SIZE = 200;
/** Concurrent upsertLeadsBulk calls in flight — mirrors CLAY_CONCURRENCY. */
export const EMAILBISON_PUSH_CONCURRENCY = 8;

/** One failed record's display name plus the concrete reason it failed —
 * "no email on record", "not returned by EmailBison lead upsert", the bulk
 * API's error message, or the platform_pushes write-back error. Lets the UI
 * render "Failed: {name} — {reason}" instead of just the name (issue #87). */
export interface EmailBisonPushFailure {
  name: string;
  reason: string;
}

export interface EmailBisonPushResult {
  total_matched: number;
  pushed: number;
  /** Of the successful pushes, records with no prior platform_pushes row for
   * (person_id, client_id, "emailbison") before this call wrote it. */
  created: number;
  /** Of the successful pushes, records that already had such a row. Together
   * `created + updated === pushed`. See the classification comment in
   * writePushRows for why this DB-side heuristic is used. */
  updated: number;
  errors: number;
  /** Display names of people whose push failed, one per failed record. */
  failed_people: string[];
  /** Same failed records as `failed_people`, paired with why each one
   * failed. */
  failed: EmailBisonPushFailure[];
  /** Person ids that were successfully pushed this call — used by the
   * background worker (issue #120) to tag push_job_records. Reflects only
   * this call's candidates (see `offset`/`deadline` on RunEmailBisonPushDeps),
   * not necessarily the whole job. */
  succeededPersonIds: string[];
  /** Person ids whose push failed this call — same per-call scope as
   * succeededPersonIds. */
  failedPersonIds: string[];
  /** Index into the deterministic candidate list (entity.loadRecords(filters))
   * to resume from on the next call — equal to total_matched once `done`. */
  nextOffset: number;
  /** True once every candidate has been attempted (across `offset`-chained
   * calls) — false means the caller hit `deadline` before finishing and
   * should call again with `offset: nextOffset`. */
  done: boolean;
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
  /** Which standard EmailBison fields to send and where companyName's value
   * comes from (issue #110, types from #108). Omitting it reproduces
   * today's behavior exactly — see buildEmailBisonLeadPayload. */
  standardFieldMapping?: EmailBisonStandardFieldMapping;
  /** Index into the resolved candidate list to resume from — the background
   * worker (issue #120) re-resolves entity.loadRecords(filters) every tick
   * (the query is deterministic for unchanged filters/data) and slices from
   * here rather than persisting the whole candidate set. Defaults to 0. */
  offset?: number;
  /** Wall-clock epoch-ms deadline: stop after the chunk group in flight when
   * it's passed, returning `done: false` and the offset to resume from,
   * rather than running the whole candidate set to completion. Omitted (the
   * default) preserves today's run-to-completion behavior for direct/test
   * callers. */
  deadline?: number;
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
 * lead in the push.
 *
 * The "existing workspace variables" reference panel
 * (app/api/clients/[id]/emailbison-custom-variables/route.ts) always
 * refetches from EmailBison directly rather than reading any cache here, so
 * newly-created variables show up there on the panel's next open without
 * this function needing to do anything more. */
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
  if (missing.length === 0) return;

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
  fetchImpl: typeof fetch,
  standardFieldMapping: EmailBisonStandardFieldMapping | undefined
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
      withEmail.map((c) =>
        buildEmailBisonLeadPayload(
          c.record,
          c.customData,
          resolveCustomVariables(customVariables, c.record, c.customData),
          existingLeadBehavior,
          standardFieldMapping
        )
      ),
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
  client: ClientRow,
  actor: Pick<SessionUser, "id" | "email">
): Promise<{ written: PushOutcome[]; failed: FailedRecord[]; createdIds: string[]; updatedIds: string[] }> {
  if (outcomes.length === 0) return { written: [], failed: [], createdIds: [], updatedIds: [] };

  // Created vs updated (feedback item 2b): EmailBison's upsert response only
  // returns {id, email} and can't tell us whether a lead was new or existing
  // (api-research.md leaves the response shape unconfirmed), so we classify
  // DB-side and uniformly across every push path — a record is "updated" if a
  // platform_pushes row for (person_id, client_id, platform) already exists
  // BEFORE this batch's upsert writes it, else "created". Snapshot that set now,
  // ahead of the writes below.
  const { data: existingRows } = await supabaseAdmin
    .from("platform_pushes")
    .select("person_id")
    .eq("client_id", client.id)
    .eq("platform", PLATFORM)
    .in(
      "person_id",
      outcomes.map((o) => o.candidate.id)
    );
  const preExisting = new Set((existingRows ?? []).map((r) => r.person_id as string));

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
          pushed_by_user_id: actor.id,
          pushed_by_email: actor.email,
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
  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      written.push(result.value);
      if (preExisting.has(result.value.candidate.id)) {
        updatedIds.push(result.value.candidate.id);
      } else {
        createdIds.push(result.value.candidate.id);
      }
    } else {
      const outcome = outcomes[i];
      failed.push({
        id: outcome.candidate.id,
        name: outcome.candidate.displayName,
        error: String(result.reason),
      });
    }
  });
  return { written, failed, createdIds, updatedIds };
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
  /** Of `pushed`, how many had no prior platform_pushes row (created) vs. one
   * that already existed (updated) — see writePushRows. */
  created: number;
  updated: number;
  errors: number;
  failed_people: string[];
  failed: EmailBisonPushFailure[];
  succeededPersonIds: string[];
  failedPersonIds: string[];
  /** How many of `candidates` were actually attempted before returning —
   * equal to candidates.length unless `deadline` cut the run short. */
  attempted: number;
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
  actor: Pick<SessionUser, "id" | "email">,
  credentials: EmailBisonCredentials,
  customVariables: EmailBisonCustomVariableEntry[],
  existingLeadBehavior: "patch" | "put",
  fetchImpl: typeof fetch,
  standardFieldMapping: EmailBisonStandardFieldMapping | undefined,
  onChunkGroupDone?: (done: number, pushed: number, errors: number) => void,
  deadline?: number
): Promise<WorkspaceUpsertOutcome> {
  const leadIdByPersonId = new Map<string, string>();
  let pushed = 0;
  let created = 0;
  let updated = 0;
  let errors = 0;
  let done = 0;
  const failed_people: string[] = [];
  const failed: EmailBisonPushFailure[] = [];
  const succeededPersonIds: string[] = [];
  const failedPersonIds: string[] = [];

  const chunks = chunk(candidates, EMAILBISON_CHUNK_SIZE);
  const groups = chunk(chunks, EMAILBISON_PUSH_CONCURRENCY);

  for (const group of groups) {
    const settled = await Promise.allSettled(
      group.map((chunkCandidates) =>
        pushChunk(chunkCandidates, credentials, customVariables, existingLeadBehavior, fetchImpl, standardFieldMapping)
      )
    );

    for (let i = 0; i < settled.length; i++) {
      const chunkCandidates = group[i];
      const outcome = settled[i];
      done += chunkCandidates.length;

      if (outcome.status === "rejected") {
        errors += chunkCandidates.length;
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        for (const c of chunkCandidates) {
          const name = c.displayName || "unknown";
          failed_people.push(name);
          failed.push({ name, reason });
          failedPersonIds.push(c.id);
        }
        console.error(`EmailBison ${label} push: chunk failed: ${String(outcome.reason)}`);
        continue;
      }

      const { written, failed: writeFailed, createdIds, updatedIds } = await writePushRows(
        outcome.value.pushed,
        client,
        actor
      );
      pushed += written.length;
      created += createdIds.length;
      updated += updatedIds.length;
      for (const w of written) {
        leadIdByPersonId.set(w.candidate.id, w.leadId);
        succeededPersonIds.push(w.candidate.id);
      }

      for (const f of [...outcome.value.failed, ...writeFailed]) {
        errors++;
        const name = f.name || "unknown";
        failed_people.push(name);
        failed.push({ name, reason: f.error });
        failedPersonIds.push(f.id);
        console.error(`EmailBison ${label} push: failed for person ${f.id} (${f.name ?? "unknown"}): ${f.error}`);
      }
    }

    onChunkGroupDone?.(done, pushed, errors);

    if (deadline !== undefined && Date.now() >= deadline && done < candidates.length) {
      break;
    }
  }

  return { leadIdByPersonId, pushed, created, updated, errors, failed_people, failed, succeededPersonIds, failedPersonIds, attempted: done };
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
  actor: Pick<SessionUser, "id" | "email">,
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
  const standardFieldMapping = deps.standardFieldMapping;
  const offset = deps.offset ?? 0;
  const deadline = deps.deadline;

  onProgress?.({ phase: "resolving", done: 0, total: 0, pushed: 0, errors: 0 });

  const candidates = await entity.loadRecords(filters);
  const total_matched = candidates.length;

  if (total_matched === 0) {
    onProgress?.({ phase: "done", done: 0, total: 0, pushed: 0, errors: 0 });
    return {
      total_matched: 0,
      pushed: 0,
      created: 0,
      updated: 0,
      errors: 0,
      failed_people: [],
      failed: [],
      succeededPersonIds: [],
      failedPersonIds: [],
      nextOffset: 0,
      done: true,
    };
  }

  const remaining = candidates.slice(offset);

  if (offset === 0) {
    await ensureCustomVariablesExist(credentials, customVariables, fetchImpl);
  }

  onProgress?.({ phase: "pushing", done: offset, total: candidates.length, pushed: 0, errors: 0 });

  const { pushed, created, updated, errors, failed_people, failed, succeededPersonIds, failedPersonIds, attempted } =
    await upsertCandidatesToWorkspace(
      remaining,
      entity.label,
      client,
      actor,
      credentials,
      customVariables,
      existingLeadBehavior,
      fetchImpl,
      standardFieldMapping,
      (chunkDone, chunkPushed, chunkErrors) =>
        onProgress?.({
          phase: "pushing",
          done: offset + chunkDone,
          total: candidates.length,
          pushed: chunkPushed,
          errors: chunkErrors,
        }),
      deadline
    );

  const nextOffset = offset + attempted;
  const isDone = nextOffset >= candidates.length;

  onProgress?.({ phase: "done", done: nextOffset, total: candidates.length, pushed, errors });

  return { total_matched, pushed, created, updated, errors, failed_people, failed, succeededPersonIds, failedPersonIds, nextOffset, done: isDone };
}

/** Add to EmailBison, triggered from the People table. */
export function runPeopleAddToEmailBison(
  filters: PersonListFilters,
  client: ClientRow,
  actor: Pick<SessionUser, "id" | "email">,
  deps: RunEmailBisonPushDeps = {}
): Promise<EmailBisonPushResult> {
  return runEmailBisonAddToWorkspace(
    { label: "people", loadRecords: getPeopleForEmailBison },
    filters,
    client,
    actor,
    deps
  );
}

/** Add to EmailBison, triggered from the Companies table — resolves to every
 * Person linked to the matching Companies (there is no company-level
 * EmailBison object, ADR 0003). */
export function runCompaniesAddToEmailBison(
  filters: CompanyListFilters,
  client: ClientRow,
  actor: Pick<SessionUser, "id" | "email">,
  deps: RunEmailBisonPushDeps = {}
): Promise<EmailBisonPushResult> {
  return runEmailBisonAddToWorkspace(
    { label: "companies", loadRecords: getPeopleForEmailBisonByCompanyFilters },
    filters,
    client,
    actor,
    deps
  );
}

export interface EmailBisonCampaignPushResult {
  total_matched: number;
  attached: number;
  /** Of the attached records, those with no prior platform_pushes row before
   * this campaign run — same DB-side heuristic as the workspace push, keyed on
   * the pre-existing rows looked up at the top of the run. */
  created: number;
  /** Of the attached records, those that already had a platform_pushes row.
   * `created + updated === attached`. */
  updated: number;
  errors: number;
  /** Display names of people whose add-to-workspace step or campaign attach
   * failed, one per failed record. */
  failed_people: string[];
  /** Same failed records as `failed_people`, paired with why each one
   * failed — e.g. "no email on record", an EmailBison API error, or (for a
   * whole-batch attach failure) the attachLeadsToCampaign error message
   * shared by every candidate in that failed attach call. */
  failed: EmailBisonPushFailure[];
  /** Person ids attached this call — see EmailBisonPushResult's identical
   * field for why this is per-call rather than whole-job scoped. */
  succeededPersonIds: string[];
  failedPersonIds: string[];
  nextOffset: number;
  done: boolean;
}

/** Candidates per resumable tick when `deadline` is set (issue #120) —
 * attachLeadsToCampaign is a single bulk call with no internal chunk
 * boundary to check a deadline against mid-call, so (unlike the workspace
 * push's chunk-group deadline check) campaign ticks are bounded by count
 * instead of wall-clock time. */
const EMAILBISON_CAMPAIGN_TICK_SIZE = 2000;

/** Person-ids per platform_pushes `.in("person_id", …)` query in a campaign
 * tick — a request-size cap, not a rate-limit concern. A tick holds up to
 * EMAILBISON_CAMPAIGN_TICK_SIZE candidates, and PostgREST rejects the URL once
 * the id list pushes it past ~11KB (~300-500 uuids), so the lookup/update
 * queries are chunked here, mirroring the 200-sized id-list chunks in
 * lib/data/people.ts (VIRTUAL_FILTER_ROW_CHUNK_SIZE, COMPANY_ID_CHUNK_SIZE). */
const CAMPAIGN_LOOKUP_CHUNK_SIZE = 200;

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
 * attachLeadsToCampaign only attaches an existing lead id to the campaign —
 * it never sends custom variables or standard-field-mapping data — so when
 * this push carries either, EVERY candidate is routed through the
 * add-to-workspace step instead, not just the ones missing a lead id;
 * re-upserting an already-existing lead is safe since existingLeadBehavior
 * defaults to "patch". Every resolvable lead id (pre-existing or freshly
 * obtained) is attached to the campaign via a single attachLeadsToCampaign
 * call, which reports
 * per-lead outcomes (issue #106 — EmailBison silently no-ops leads already
 * active in another campaign, so a bare 2xx for the batch can't be trusted).
 * Only the candidates whose lead id actually attached get their
 * platform_pushes row updated with campaign_tag (repurposed to hold the
 * campaign id, matching GHL's tag column) and pushed_at; the rest are
 * reported as failed with EmailBison's per-lead reason. An exception from
 * the attach call itself (or the write-back) fails every candidate that
 * would have been attached, without touching the workspace-upsert results
 * already written. */
async function runEmailBisonAddToCampaign<TFilters>(
  entity: EmailBisonEntity<TFilters>,
  filters: TFilters,
  client: ClientRow,
  campaignId: string,
  actor: Pick<SessionUser, "id" | "email">,
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
  const standardFieldMapping = deps.standardFieldMapping;
  const offset = deps.offset ?? 0;
  const tickSize = deps.deadline !== undefined ? EMAILBISON_CAMPAIGN_TICK_SIZE : Infinity;

  onProgress?.({ phase: "resolving", done: 0, total: 0, attached: 0, errors: 0 });

  const allCandidates = await entity.loadRecords(filters);
  const total_matched = allCandidates.length;

  if (total_matched === 0) {
    onProgress?.({ phase: "done", done: 0, total: 0, attached: 0, errors: 0 });
    return {
      total_matched: 0,
      attached: 0,
      created: 0,
      updated: 0,
      errors: 0,
      failed_people: [],
      failed: [],
      succeededPersonIds: [],
      failedPersonIds: [],
      nextOffset: 0,
      done: true,
    };
  }

  const candidates = allCandidates.slice(offset, offset + tickSize);
  const nextOffset = offset + candidates.length;
  const isDone = nextOffset >= total_matched;

  // Chunked at CAMPAIGN_LOOKUP_CHUNK_SIZE so the `.in("person_id", …)` URL stays
  // under PostgREST's length limit even for a full 2000-candidate tick; rows are
  // merged and order doesn't matter (they feed a Set and a Map below).
  const lookupChunks = chunk(
    candidates.map((c) => c.id),
    CAMPAIGN_LOOKUP_CHUNK_SIZE
  );
  const lookupResults = await Promise.all(
    lookupChunks.map((ids) =>
      supabaseAdmin
        .from("platform_pushes")
        .select("person_id,platform_contact_id")
        .eq("client_id", client.id)
        .eq("platform", PLATFORM)
        .in("person_id", ids)
    )
  );
  const lookupError = lookupResults.find((r) => r.error)?.error;
  if (lookupError) throw lookupError;
  const existingRows = lookupResults.flatMap((r) => r.data ?? []);

  const leadIdByPersonId = new Map<string, string>();
  // Created vs updated (feedback item 2b), same DB-side heuristic as the
  // workspace push: a candidate that already had ANY platform_pushes row for
  // this (client, platform) before this run is "updated", the rest "created".
  // `existingRows` is exactly that pre-existing set, so snapshot its person_ids
  // here — before the attach step writes/updates rows below.
  const preExistingPersonIds = new Set((existingRows ?? []).map((r) => r.person_id as string));
  for (const row of existingRows ?? []) {
    if (row.platform_contact_id) {
      leadIdByPersonId.set(row.person_id as string, row.platform_contact_id as string);
    }
  }

  // attachLeadsToCampaign never sends customVariables/standardFieldMapping —
  // it only attaches an existing lead id — so a candidate that already has a
  // lead id still needs to go through the upsert step when this push carries
  // field data to sync, otherwise that data silently never reaches EmailBison
  // (issue verified live: a re-pushed lead with new custom variables reported
  // "succeeded" but the variables were never created/applied). Re-upserting
  // an already-existing lead is safe (existingLeadBehavior defaults to
  // "patch"). With no field data to sync, the original short-circuit stands.
  const needsFieldSync = customVariables.length > 0 || standardFieldMapping !== undefined;
  const needsUpsert = needsFieldSync ? candidates : candidates.filter((c) => !leadIdByPersonId.has(c.id));

  let errors = 0;
  const failed_people: string[] = [];
  const failed: EmailBisonPushFailure[] = [];
  const failedPersonIds: string[] = [];

  if (needsUpsert.length > 0) {
    onProgress?.({ phase: "adding-to-workspace", done: 0, total: needsUpsert.length, attached: 0, errors: 0 });
    await ensureCustomVariablesExist(credentials, customVariables, fetchImpl);

    const upsertOutcome = await upsertCandidatesToWorkspace(
      needsUpsert,
      entity.label,
      client,
      actor,
      credentials,
      customVariables,
      existingLeadBehavior,
      fetchImpl,
      standardFieldMapping,
      (done) => onProgress?.({ phase: "adding-to-workspace", done, total: needsUpsert.length, attached: 0, errors: 0 })
    );
    for (const [personId, leadId] of upsertOutcome.leadIdByPersonId) {
      leadIdByPersonId.set(personId, leadId);
    }
    errors += upsertOutcome.errors;
    failed_people.push(...upsertOutcome.failed_people);
    failed.push(...upsertOutcome.failed);
    failedPersonIds.push(...upsertOutcome.failedPersonIds);
  }

  const attachable = candidates.filter((c) => leadIdByPersonId.has(c.id));

  if (attachable.length === 0) {
    onProgress?.({ phase: "done", done: nextOffset, total: total_matched, attached: 0, errors });
    return {
      total_matched,
      attached: 0,
      created: 0,
      updated: 0,
      errors,
      failed_people,
      failed,
      succeededPersonIds: [],
      failedPersonIds,
      nextOffset,
      done: isDone,
    };
  }

  onProgress?.({ phase: "attaching", done: 0, total: attachable.length, attached: 0, errors });

  let attached = 0;
  let created = 0;
  let updated = 0;
  const succeededPersonIds: string[] = [];
  try {
    const attachResult = await attachLeadsToCampaign(
      credentials,
      campaignId,
      attachable.map((c) => leadIdByPersonId.get(c.id)!),
      { parallel: deps.parallel },
      { fetchImpl }
    );

    const attachedLeadIds = new Set(attachResult.attached);
    const attachedCandidates = attachable.filter((c) => attachedLeadIds.has(leadIdByPersonId.get(c.id)!));
    const unattachedCandidates = attachable.filter((c) => !attachedLeadIds.has(leadIdByPersonId.get(c.id)!));

    if (attachedCandidates.length > 0) {
      const pushedAt = new Date().toISOString();
      // Chunked at CAMPAIGN_LOOKUP_CHUNK_SIZE for the same URL-length reason as
      // the lookup above; same payload per chunk, fail-fast on any chunk error.
      const updateChunks = chunk(
        attachedCandidates.map((c) => c.id),
        CAMPAIGN_LOOKUP_CHUNK_SIZE
      );
      const updateResults = await Promise.all(
        updateChunks.map((ids) =>
          supabaseAdmin
            .from("platform_pushes")
            .update({
              campaign_tag: campaignId,
              pushed_at: pushedAt,
              pushed_by_user_id: actor.id,
              pushed_by_email: actor.email,
            })
            .eq("client_id", client.id)
            .eq("platform", PLATFORM)
            .in("person_id", ids)
        )
      );
      const updateError = updateResults.find((r) => r.error)?.error;
      if (updateError) throw updateError;
    }

    attached = attachedCandidates.length;
    for (const c of attachedCandidates) {
      if (preExistingPersonIds.has(c.id)) updated++;
      else created++;
    }
    succeededPersonIds.push(...attachedCandidates.map((c) => c.id));

    if (unattachedCandidates.length > 0) {
      const reasonByLeadId = new Map(attachResult.failed.map((f) => [f.leadId, f.reason]));
      errors += unattachedCandidates.length;
      for (const c of unattachedCandidates) {
        const name = c.displayName || "unknown";
        const reason = reasonByLeadId.get(leadIdByPersonId.get(c.id)!) ?? "not attached by EmailBison";
        failed_people.push(name);
        failed.push({ name, reason });
        failedPersonIds.push(c.id);
        console.error(`EmailBison ${entity.label} add-to-campaign: attach failed for person ${c.id} (${name}): ${reason}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors += attachable.length;
    for (const c of attachable) {
      const name = c.displayName || "unknown";
      failed_people.push(name);
      failed.push({ name, reason: message });
      failedPersonIds.push(c.id);
    }
    console.error(`EmailBison ${entity.label} add-to-campaign: attach failed: ${message}`);
  }

  onProgress?.({ phase: "done", done: nextOffset, total: total_matched, attached, errors });

  return { total_matched, attached, created, updated, errors, failed_people, failed, succeededPersonIds, failedPersonIds, nextOffset, done: isDone };
}

/** Add to Campaign, triggered from the People table. */
export function runPeopleAddToCampaign(
  filters: PersonListFilters,
  client: ClientRow,
  campaignId: string,
  actor: Pick<SessionUser, "id" | "email">,
  deps: RunEmailBisonCampaignPushDeps = {}
): Promise<EmailBisonCampaignPushResult> {
  return runEmailBisonAddToCampaign(
    { label: "people", loadRecords: getPeopleForEmailBison },
    filters,
    client,
    campaignId,
    actor,
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
  actor: Pick<SessionUser, "id" | "email">,
  deps: RunEmailBisonCampaignPushDeps = {}
): Promise<EmailBisonCampaignPushResult> {
  return runEmailBisonAddToCampaign(
    { label: "companies", loadRecords: getPeopleForEmailBisonByCompanyFilters },
    filters,
    client,
    campaignId,
    actor,
    deps
  );
}
