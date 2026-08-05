import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getPeopleForGhl, type GhlPushCandidate } from "@/lib/data/people";
import type { PersonListFilters } from "@/lib/data/people";
import { pushContactToGhl, GhlApiError, type GhlCredentials } from "@/lib/ghl/client";
import { buildGhlTag } from "@/lib/ghl/tag";
import { buildGhlContactPayload, buildGhlCustomFields } from "@/lib/ghl/contact-payload";
import type { ClientRow } from "@/lib/data/clients";
import type { GhlFieldMapping, GhlStandardFieldMapping } from "@/lib/ghl/types";
import type { SessionUser } from "@/lib/auth/dal";

export const GHL_PUSH_CONCURRENCY = 8;
const PLATFORM = "ghl";

/** Only these phone_type values are eligible for a GHL push — landlines (and
 * anything else, including null/unverified) are skipped. */
const ELIGIBLE_PHONE_TYPES = new Set(["mobile", "toll_free"]);

export interface GhlPushResult {
  total_matched: number;
  eligible: number;
  skipped: number;
  pushed: number;
  /** Of `pushed`, how many were brand-new GHL contacts. */
  created: number;
  /** Of `pushed`, how many were existing GHL contacts that only got the tag appended. */
  tagAppended: number;
  errors: number;
  /** Display names of people whose push failed, one per failed record. */
  failed_people: string[];
  /** Person ids pushed successfully this call — used by the background
   * worker (issue #120) to tag push_job_records. Reflects only this call's
   * candidates (see `offset`/`deadline` on RunGhlPushDeps), not necessarily
   * the whole job. */
  succeededPersonIds: string[];
  /** Person ids whose push failed this call — same per-call scope. */
  failedPersonIds: string[];
  /** Index into the deterministic eligible-candidate list to resume from on
   * the next call — equal to `eligible` once `done`. */
  nextOffset: number;
  /** True once every eligible candidate has been attempted (across
   * `offset`-chained calls) — false means the caller hit `deadline` before
   * finishing and should call again with `offset: nextOffset`. */
  done: boolean;
}

export interface GhlPushProgress {
  phase: "resolving" | "pushing" | "done";
  done: number;
  total: number;
  pushed: number;
  errors: number;
}

export interface RunGhlPushDeps {
  fetchImpl?: typeof fetch;
  onProgress?: (p: GhlPushProgress) => void;
  /** Active virtual-column → GHL-field mapping from the push button's
   * mapping step (ticket #51). Empty/omitted means no mapping was offered
   * (no virtual columns were active) or every column was skipped. */
  fieldMapping?: GhlFieldMapping[];
  /** Standard (non-custom) field mapping from the push button's mapping step
   * (ticket #109), e.g. skipping city or choosing raw company_name over
   * brand_name. Omitted means no mapping was offered — today's always-include,
   * prefer-brand-name behavior is preserved. */
  standardFieldMapping?: GhlStandardFieldMapping;
  /** Optional extra identifier (e.g. "leadership", "marketing", a segment
   * name) appended as one more pipe-delimited segment on every tag built for
   * this run — see buildGhlTag. Left undefined/blank, the tag format is
   * unchanged. */
  customTagSuffix?: string | null;
  /** Index into the resolved eligible-candidate list to resume from — the
   * background worker (issue #120) re-resolves getPeopleForGhl(filters)
   * every tick (deterministic for unchanged filters/data) and slices from
   * here rather than persisting the whole candidate set. Defaults to 0. */
  offset?: number;
  /** Wall-clock epoch-ms deadline: stop after the group in flight when it's
   * passed, returning `done: false` and the offset to resume from, rather
   * than running the whole eligible set to completion. Omitted (the
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

function isEligible(candidate: GhlPushCandidate): boolean {
  return candidate.phoneType != null && ELIGIBLE_PHONE_TYPES.has(candidate.phoneType);
}

export interface GhlEligibilitySplit {
  total_matched: number;
  eligible: GhlPushCandidate[];
  skipped: number;
}

/** Splits resolved candidates into eligible (mobile/toll-free) vs skipped
 * (landline/other/unverified), without pushing anything — the shared basis
 * for both the push engine's own resolve step and the preview endpoint the
 * confirm screen uses to show counts ahead of time. */
export function splitGhlEligibility(candidates: GhlPushCandidate[]): GhlEligibilitySplit {
  const eligible = candidates.filter(isEligible);
  return {
    total_matched: candidates.length,
    eligible,
    skipped: candidates.length - eligible.length,
  };
}

type PushOneResult = { ok: true; deduped: boolean } | { ok: false; error: string };

/** Pushes a single person to GHL, then logs the result to platform_pushes and
 * flips the person's pushed_to_ghl flag. platform_pushes is upserted (not
 * inserted) on the (person_id, client_id, platform) unique key — this record
 * is resent on every run, so a prior push row is overwritten with the latest
 * attempt rather than causing a conflict. Only successful pushes are logged;
 * a failure just contributes to the batch's error count. */
async function pushOne(
  candidate: GhlPushCandidate,
  client: ClientRow,
  actor: Pick<SessionUser, "id" | "email">,
  credentials: GhlCredentials,
  fetchImpl: typeof fetch,
  fieldMapping: GhlFieldMapping[],
  standardFieldMapping: GhlStandardFieldMapping | undefined,
  customTagSuffix?: string | null
): Promise<PushOneResult> {
  const tag = buildGhlTag(client.name, candidate.record, customTagSuffix);
  const customFields = buildGhlCustomFields(candidate.customData, fieldMapping);
  const payload = buildGhlContactPayload(candidate.record, [tag], customFields, standardFieldMapping);

  try {
    const { contactId, deduped } = await pushContactToGhl(
      credentials,
      {
        firstName: payload.firstName ?? undefined,
        lastName: payload.lastName ?? undefined,
        email: payload.email ?? undefined,
        phone: payload.phone ?? undefined,
        companyName: payload.companyName ?? undefined,
        city: payload.city ?? undefined,
        country: payload.country ?? undefined,
        tags: payload.tags,
        ...(payload.customFields.length > 0 ? { customFields: payload.customFields } : {}),
      },
      { fetchImpl }
    );

    const pushedAt = new Date().toISOString();

    const { error: pushError } = await supabaseAdmin.from("platform_pushes").upsert(
      {
        person_id: candidate.id,
        client_id: client.id,
        platform: PLATFORM,
        platform_contact_id: contactId,
        campaign_tag: tag,
        pushed_at: pushedAt,
        pushed_by_user_id: actor.id,
        pushed_by_email: actor.email,
      },
      { onConflict: "person_id,client_id,platform" }
    );
    if (pushError) throw pushError;

    const { error: personError } = await supabaseAdmin
      .from("people")
      .update({ pushed_to_ghl: true, pushed_to_ghl_at: pushedAt })
      .eq("id", candidate.id);
    if (personError) throw personError;

    return { ok: true, deduped };
  } catch (err) {
    const message =
      err instanceof GhlApiError || err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Push every eligible (mobile/toll-free) person in the current filtered
 * People view to `client`'s GHL location. Landline (and any other/unverified)
 * phone types are excluded and counted in `skipped` rather than attempted.
 *
 * Mirrors runClayPush's resend-every-run behavior: there is no
 * skip-already-pushed check against platform_pushes, so every eligible
 * record is pushed (and its platform_pushes row overwritten) on every call. A
 * failure on one record never aborts the batch — results are collected via
 * Promise.allSettled per concurrency chunk, the same pattern
 * lib/clay/push-to-clay.ts uses. */
export async function runPeopleGhlPush(
  filters: PersonListFilters,
  client: ClientRow,
  actor: Pick<SessionUser, "id" | "email">,
  deps: RunGhlPushDeps = {}
): Promise<GhlPushResult> {
  if (!client.ghlApiKey || !client.ghlLocationId) {
    throw new Error(`Client "${client.name}" has no GHL credentials configured`);
  }

  const credentials: GhlCredentials = {
    apiKey: client.ghlApiKey,
    locationId: client.ghlLocationId,
  };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const onProgress = deps.onProgress;
  const fieldMapping = deps.fieldMapping ?? [];
  const standardFieldMapping = deps.standardFieldMapping;
  const customTagSuffix = deps.customTagSuffix;
  const offset = deps.offset ?? 0;
  const deadline = deps.deadline;

  onProgress?.({ phase: "resolving", done: 0, total: 0, pushed: 0, errors: 0 });

  const candidates = await getPeopleForGhl(filters);
  const { total_matched, eligible, skipped } = splitGhlEligibility(candidates);

  if (eligible.length === 0) {
    onProgress?.({ phase: "done", done: 0, total: 0, pushed: 0, errors: 0 });
    return {
      total_matched,
      eligible: 0,
      skipped,
      pushed: 0,
      created: 0,
      tagAppended: 0,
      errors: 0,
      failed_people: [],
      succeededPersonIds: [],
      failedPersonIds: [],
      nextOffset: 0,
      done: true,
    };
  }

  const remaining = eligible.slice(offset);

  onProgress?.({ phase: "pushing", done: offset, total: eligible.length, pushed: 0, errors: 0 });

  let pushed = 0;
  let created = 0;
  let tagAppended = 0;
  let errors = 0;
  let attempted = 0;
  const failed_people: string[] = [];
  const succeededPersonIds: string[] = [];
  const failedPersonIds: string[] = [];

  const groups = chunk(remaining, GHL_PUSH_CONCURRENCY);

  for (const group of groups) {
    const results = await Promise.allSettled(
      group.map(async (candidate) => ({
        candidate,
        result: await pushOne(
          candidate,
          client,
          actor,
          credentials,
          fetchImpl,
          fieldMapping,
          standardFieldMapping,
          customTagSuffix
        ),
      }))
    );

    for (const settled of results) {
      attempted++;
      if (settled.status === "fulfilled" && settled.value.result.ok) {
        pushed++;
        succeededPersonIds.push(settled.value.candidate.id);
        if (settled.value.result.deduped) {
          tagAppended++;
        } else {
          created++;
        }
      } else {
        errors++;
        const candidate = settled.status === "fulfilled" ? settled.value.candidate : null;
        const reason =
          settled.status === "fulfilled"
            ? (settled.value.result as { ok: false; error: string }).error
            : String((settled as PromiseRejectedResult).reason);
        failed_people.push(candidate?.displayName || "unknown");
        if (candidate) failedPersonIds.push(candidate.id);
        // platform_pushes has no column for a failed attempt, so this is the
        // only place a failure's actual cause (vs. just "who failed") is
        // recoverable — mirrors lib/clay/push-to-clay.ts's best-effort
        // console.error on its own logging failures.
        console.error(
          `GHL push: failed for person ${candidate?.id ?? "unknown"} (${candidate?.displayName ?? "unknown"}): ${reason}`
        );
      }
    }

    onProgress?.({ phase: "pushing", done: offset + attempted, total: eligible.length, pushed, errors });

    if (deadline !== undefined && Date.now() >= deadline && attempted < remaining.length) {
      break;
    }
  }

  const nextOffset = offset + attempted;
  const isDone = nextOffset >= eligible.length;

  onProgress?.({ phase: "done", done: nextOffset, total: eligible.length, pushed, errors });

  return {
    total_matched,
    eligible: eligible.length,
    skipped,
    pushed,
    created,
    tagAppended,
    errors,
    failed_people,
    succeededPersonIds,
    failedPersonIds,
    nextOffset,
    done: isDone,
  };
}
