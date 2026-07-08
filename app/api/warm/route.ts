import { getDashboard } from "@/lib/data/dashboard";
import { getPeople } from "@/lib/data/people";
import { getCompanies } from "@/lib/data/companies";

/**
 * Cache-warming endpoint pinged from the login screen (see login-form.tsx).
 *
 * The dominant cost on the dashboard and the /people and /companies lists is a
 * full-table scan of ~29k rows, cached process-locally under the stable keys
 * `people:base` / `companies:base` (1h TTL) and `getDashboard` (60s TTL). By
 * kicking those fetches off while the user is still typing their credentials,
 * the caches are already warm by the time they land on an authenticated page,
 * so the Suspense skeletons resolve immediately instead of blocking on the DB.
 *
 * Public (allowed through the auth proxy) but it returns no data — only a 204 —
 * so nothing is exposed to an unauthenticated caller. Repeat hits within the
 * TTL are no-ops that share the in-flight promise, so this can't be used to
 * pile up redundant scans. We pull a single row from each list to exercise the
 * exact code paths the pages use without doing needless pagination work.
 */
export async function GET() {
  await Promise.allSettled([
    getDashboard({}),
    getPeople({}, 1, 1),
    getCompanies({}, 1, 1),
  ]);

  return new Response(null, { status: 204 });
}
