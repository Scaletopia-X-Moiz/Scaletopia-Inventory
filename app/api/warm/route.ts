import { getDashboard } from "@/lib/data/dashboard";
import { getPeople } from "@/lib/data/people";
import { getCompanies } from "@/lib/data/companies";

/**
 * Cache-warming endpoint pinged from the login screen (see login-form.tsx).
 *
 * /people and /companies now filter/sort/paginate entirely in Postgres (see
 * docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md), so
 * there's no app-level list cache left to warm — only `getDashboard` still
 * caches (60s TTL). This still primes a Postgres connection and exercises the
 * exact list/dashboard code paths while the user is typing their credentials,
 * so the first authenticated request isn't paying a cold-start connection
 * cost. We pull a single row from each list to exercise the exact code paths
 * the pages use without doing needless pagination work.
 *
 * Public (allowed through the auth proxy) but it returns no data — only a 204 —
 * so nothing is exposed to an unauthenticated caller.
 */
export async function GET() {
  await Promise.allSettled([
    getDashboard({}),
    getPeople({}, 1, 1),
    getCompanies({}, 1, 1),
  ]);

  return new Response(null, { status: 204 });
}
