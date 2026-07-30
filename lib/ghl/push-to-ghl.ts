import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getPeopleForGhl, type GhlPushCandidate } from "@/lib/data/people";
import type { PersonListFilters } from "@/lib/data/people";
import { pushContactToGhl, GhlApiError, type GhlCredentials } from "@/lib/ghl/client";
import { buildGhlTag } from "@/lib/ghl/tag";
import { buildGhlContactPayload } from "@/lib/ghl/contact-payload";
import type { ClientRow } from "@/lib/data/clients";

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
  errors: number;
  /** Display names of people whose push failed, one per failed record. */
  failed_people: string[];
}

export interface RunGhlPushDeps {
  fetchImpl?: typeof fetch;
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

type PushOneResult = { ok: true } | { ok: false; error: string };

/** Pushes a single person to GHL, then logs the result to platform_pushes and
 * flips the person's pushed_to_ghl flag. platform_pushes is upserted (not
 * inserted) on the (person_id, client_id, platform) unique key — this record
 * is resent on every run, so a prior push row is overwritten with the latest
 * attempt rather than causing a conflict. Only successful pushes are logged;
 * a failure just contributes to the batch's error count. */
async function pushOne(
  candidate: GhlPushCandidate,
  client: ClientRow,
  credentials: GhlCredentials,
  fetchImpl: typeof fetch
): Promise<PushOneResult> {
  const tag = buildGhlTag(client.name, candidate.record);
  const payload = buildGhlContactPayload(candidate.record, [tag]);

  try {
    const { contactId } = await pushContactToGhl(
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
      },
      { onConflict: "person_id,client_id,platform" }
    );
    if (pushError) throw pushError;

    const { error: personError } = await supabaseAdmin
      .from("people")
      .update({ pushed_to_ghl: true, pushed_to_ghl_at: pushedAt })
      .eq("id", candidate.id);
    if (personError) throw personError;

    return { ok: true };
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

  const candidates = await getPeopleForGhl(filters);
  const total_matched = candidates.length;
  const eligible = candidates.filter(isEligible);
  const skipped = total_matched - eligible.length;

  let pushed = 0;
  let errors = 0;
  const failed_people: string[] = [];

  for (const group of chunk(eligible, GHL_PUSH_CONCURRENCY)) {
    const results = await Promise.allSettled(
      group.map(async (candidate) => ({
        candidate,
        result: await pushOne(candidate, client, credentials, fetchImpl),
      }))
    );

    for (const settled of results) {
      if (settled.status === "fulfilled" && settled.value.result.ok) {
        pushed++;
      } else {
        errors++;
        const candidate = settled.status === "fulfilled" ? settled.value.candidate : null;
        const reason =
          settled.status === "fulfilled"
            ? (settled.value.result as { ok: false; error: string }).error
            : String((settled as PromiseRejectedResult).reason);
        failed_people.push(candidate?.displayName || "unknown");
        // platform_pushes has no column for a failed attempt, so this is the
        // only place a failure's actual cause (vs. just "who failed") is
        // recoverable — mirrors lib/clay/push-to-clay.ts's best-effort
        // console.error on its own logging failures.
        console.error(
          `GHL push: failed for person ${candidate?.id ?? "unknown"} (${candidate?.displayName ?? "unknown"}): ${reason}`
        );
      }
    }
  }

  return { total_matched, eligible: eligible.length, skipped, pushed, errors, failed_people };
}
