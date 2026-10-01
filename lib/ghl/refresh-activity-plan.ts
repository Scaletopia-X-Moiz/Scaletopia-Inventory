import "server-only";
import { getAllFilteredPeople, tryCountFilteredPeople, type PersonListFilters } from "@/lib/data/people";
import { countPushedPeople, getClientsForPeople } from "@/lib/data/ghl-activity";
import { MAX_FILTERED_PEOPLE, MAX_FILTER_SCAN, type ActivityScope } from "@/lib/ghl/activity-scope";

/** What a refresh request will actually do, resolved before anything is
 * queued — so the endpoint and the dialog's preview answer from one place and
 * cannot disagree about what the user is about to spend.
 *
 * This exists because the previous shape could not tell the truth: a
 * `kind: "filters"` request stored the filter snapshot and the sync then
 * refreshed the client's ENTIRE pushed set, while the dialog said "every
 * person matching the current filters (N)". Resolving the population here,
 * once, makes the number the user is shown the number the job runs on. */

/** How the population was arrived at. The user-facing difference is what the
 * dialog must say: "the people you selected", "the people your filters
 * match", or "everything this sub-account has ever pushed". */
export type RefreshPlanMode = "ids" | "filtered" | "all_pushed";

export interface RefreshPlanClient {
  clientId: string;
  /** Distinct people this sub-account will refresh. */
  personCount: number;
  /** Those people, so a caller that ends up enqueueing only SOME of the
   * sub-accounts (one is missing credentials, say) can still report a
   * distinct head count for the ones it did. Empty for `all_pushed`, which
   * names no people. */
  personIds: string[];
  /** The GHL contacts to pre-load into this job's queue partition, or null
   * when the job resolves its own work list (`all_pushed`, and `ids`, which
   * carries its person ids on the job row). */
  ghlContactIds: string[] | null;
  /** Upper bound on this sub-account's GHL calls: one `messages/export` per
   * contact. Not `personCount` — GHL dedupes on phone, so two people can
   * share one contact and cost one call. */
  estimatedCalls: number;
}

export interface RefreshPlan {
  mode: RefreshPlanMode;
  clients: RefreshPlanClient[];
  /** Distinct people across every sub-account, not the sum of the per-client
   * counts — a person pushed to three sub-accounts is one person and three
   * calls, and conflating those is how a cost estimate stops being one. */
  personCount: number;
  /** Sum of the per-client call estimates, i.e. people x sub-accounts they
   * were pushed to. An UPPER bound: an `all_pushed` run that is not `full`
   * sweeps first and only re-reads conversations that moved, usually a
   * handful. A targeted or filtered run has no such saving — it was asked for
   * specific people and re-reads every one of them. */
  estimatedCalls: number;
}

export type RefreshPlanCode = "too_many_filtered" | "empty_scope";

export type RefreshPlanResult = { ok: true; plan: RefreshPlan } | { ok: false; code: RefreshPlanCode; error: string };

/** Whether the request's filter snapshot narrows anything at all.
 *
 * An empty snapshot is NOT "every person in the database": it is the legacy
 * `{ clientId, full }` body and the dialog's unfiltered view, both of which
 * mean "this whole sub-account" and are served by the sync's own
 * whole-pushed-set path for a fraction of the cost. Resolving them through
 * the filter path instead would turn a cheap incremental run into a 136,000-id
 * resolution that then gets rejected for being too large.
 *
 * `virtualColumns` is deliberately absent — it only adds columns to the
 * rendered table and changes no row's membership. */
export function hasActivePersonFilters(filters: PersonListFilters): boolean {
  return Boolean(
    filters.search?.trim() ||
      filters.niche ||
      filters.source ||
      filters.country ||
      filters.employeeBucket?.length ||
      filters.industry ||
      filters.email ||
      filters.phone ||
      filters.emailStatus ||
      filters.phoneType ||
      filters.mxProvider ||
      filters.jobTitle?.trim() ||
      filters.jobTitleExclude?.trim() ||
      filters.employeeMin != null ||
      filters.employeeMax != null ||
      filters.pushJobId ||
      filters.pushStatus ||
      filters.lastActivity ||
      filters.virtualFilters
  );
}

/** The one filter resolver this feature uses. Deliberately `getAllFilteredPeople`
 * — the same function the People table, the CSV export and the push preview
 * resolve through — so a filtered refresh can never match a different set
 * from the one the user is looking at. */
async function resolveFilteredPersonIds(filters: PersonListFilters): Promise<string[]> {
  return (await getAllFilteredPeople(filters)).map((row) => row.id);
}

/** Refusal for a population too large to RESOLVE, which is a different
 * refusal from "too expensive to run" and has to read like one: we are not
 * claiming these people would cost API calls, only that finding out which of
 * them would is itself the expensive part. */
function tooLargeToPrice(matched: number): RefreshPlanResult {
  return {
    ok: false,
    code: "too_many_filtered",
    error:
      `These filters match ${matched.toLocaleString("en-US")} people. Working out which of them have been pushed ` +
      `to GHL — the only ones a refresh costs anything for — means resolving all ${matched.toLocaleString("en-US")}, ` +
      `which is too slow to do on a click. Narrow the filters below ` +
      `${MAX_FILTER_SCAN.toLocaleString("en-US")} matches and refresh in batches.`,
  };
}

function summarize(mode: RefreshPlanMode, clients: RefreshPlanClient[], personCount: number): RefreshPlan {
  return {
    mode,
    clients,
    personCount,
    estimatedCalls: clients.reduce((sum, c) => sum + c.estimatedCalls, 0),
  };
}

/** Resolves a refresh request to the concrete sub-accounts, people and cost it
 * implies. Reads only; the caller decides whether to enqueue.
 *
 * `clientIds` INTERSECTS the sub-accounts a population actually lives in
 * rather than overriding them — narrowing to a sub-account none of these
 * people were pushed to yields nothing, which is the honest answer. For an
 * `all_pushed` plan there is no population to intersect, so it is the only
 * signal and is required. */
export async function planActivityRefresh(input: {
  scope: ActivityScope;
  filters: PersonListFilters;
  clientIds: string[] | null;
}): Promise<RefreshPlanResult> {
  const narrow = input.clientIds && input.clientIds.length > 0 ? new Set(input.clientIds) : null;

  if (input.scope.kind === "filters" && !hasActivePersonFilters(input.filters)) {
    if (!narrow) {
      return {
        ok: false,
        code: "empty_scope",
        error:
          "Pick a sub-account (or apply a filter): with no filters and no selection there is no population to refresh, " +
          "only 'every contact in every sub-account'.",
      };
    }
    const clients = await Promise.all(
      Array.from(narrow, async (clientId) => {
        const pushed = await countPushedPeople(clientId);
        return { clientId, personCount: pushed, personIds: [], ghlContactIds: null, estimatedCalls: pushed };
      })
    );
    // Summed, not de-duplicated: these are whole sub-accounts, and we have no
    // id set to tell us whether the same person sits in two of them. Named
    // `all_pushed` precisely so the dialog can say "per sub-account" instead
    // of pretending to a distinct-people number it cannot compute.
    return {
      ok: true,
      plan: summarize(
        "all_pushed",
        clients,
        clients.reduce((sum, c) => sum + c.personCount, 0)
      ),
    };
  }

  let personIds: string[];
  let mode: RefreshPlanMode;
  let matchedCount = 0;
  if (input.scope.kind === "ids") {
    personIds = input.scope.personIds;
    mode = "ids";
  } else {
    mode = "filtered";
    // Counted BEFORE anything is materialized where that is possible at all
    // (lib/data/people.ts): fetching 80,000 person rows in order to reject
    // them is the expensive half of the request, and the preview repeats it
    // every time the user changes their mind.
    const cheapCount = await tryCountFilteredPeople(input.filters);
    if (cheapCount != null && cheapCount > MAX_FILTER_SCAN) return tooLargeToPrice(cheapCount);

    personIds = await resolveFilteredPersonIds(input.filters);
    matchedCount = personIds.length;
    // The id-restricted filter paths have no cheap count, so they are judged
    // after resolving — still before the `platform_pushes` fan-out, which is
    // the part that scales with the population.
    if (matchedCount > MAX_FILTER_SCAN) return tooLargeToPrice(matchedCount);
  }

  const pushedTo = await getClientsForPeople(personIds);
  const matched = narrow ? pushedTo.filter((row) => narrow.has(row.clientId)) : pushedTo;

  // Distinct people that landed SOMEWHERE, unioned across sub-accounts — not
  // the size of the population and not the sum of the per-client counts.
  // Reporting "refreshing 50 people" when 30 were never pushed, or "80"
  // because 30 of them were pushed to two sub-accounts, are both numbers the
  // user cannot reconcile with what they then see.
  const reached = new Set<string>();
  for (const row of matched) for (const id of row.personIds) reached.add(id);

  // The cap applies to the population that actually spends GHL calls, not to
  // the population the filters match. Those are wildly different numbers:
  // filters matching 30,000 people of whom 12 were ever pushed cost 12 calls,
  // and refusing that refresh — on the grounds that each of the 30,000 costs
  // a call per sub-account, which is simply false for the 29,988 that have no
  // contact to read — was both wrong and wrongly explained.
  const estimatedCalls = matched.reduce((sum, row) => sum + row.ghlContactIds.length, 0);
  if (mode === "filtered" && reached.size > MAX_FILTERED_PEOPLE) {
    return {
      ok: false,
      code: "too_many_filtered",
      error:
        `${reached.size.toLocaleString("en-US")} of the ${matchedCount.toLocaleString("en-US")} people these ` +
        `filters match have been pushed to GHL, costing about ${estimatedCalls.toLocaleString("en-US")} API ` +
        `calls across ${matched.length.toLocaleString("en-US")} ${matched.length === 1 ? "sub-account" : "sub-accounts"}. ` +
        `A filtered refresh takes at most ${MAX_FILTERED_PEOPLE.toLocaleString("en-US")} pushed people. ` +
        `Narrow the filters and refresh in batches.`,
    };
  }

  return {
    ok: true,
    plan: summarize(
      mode,
      matched.map((row) => ({
        clientId: row.clientId,
        personCount: row.personCount,
        personIds: row.personIds,
        // An `ids` job carries its person ids on the job row and re-resolves
        // its contacts itself; only a filtered job needs its work list frozen
        // into the queue, because its filter would drift under it.
        ghlContactIds: mode === "filtered" ? row.ghlContactIds : null,
        estimatedCalls: row.ghlContactIds.length,
      })),
      reached.size
    ),
  };
}
