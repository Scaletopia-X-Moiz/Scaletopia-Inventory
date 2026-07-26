## Problem Statement

Using the app feels slow everywhere, not just on data-heavy screens. Opening the
front page (Overview) takes a long time, and simply switching tabs — e.g. from
the Overview to the Team page — is sluggish even though those pages need little
or no data. From a user sitting at the app, every navigation has a noticeable
pause before anything appears, which makes the whole tool feel heavy for an
internal team that clicks between sections constantly.

Two independent things cause this, both measured against the live database on
2026-07-26:

1. **Every navigation pays a ~975 ms fixed "auth floor."** Before any page
   renders, the app validates the signed-in user over the network *twice*
   (once in the middleware, once in the page layout) and then runs a database
   query to look up the user's role — three serial round-trips to Supabase, on
   every page and every API call, regardless of how cheap the page itself is.
   This is why even the Team page is slow.
2. **The Overview page additionally scans the entire companies table in the
   browser-facing server and aggregates it in JavaScript.** The companies table
   is now **109,756 rows** (the code still assumes "~29k"). Building the
   dashboard charts pulls all of them across 110 paginated requests (~10 MB) and
   counts them up in application code, measured at **~9.8 seconds** cold.

## Solution

Make the app faster **without changing anything a user sees or can do** — only
latency changes.

1. **Validate the session locally instead of over the network, and stop
   re-validating twice.** The Supabase project already publishes an ES256
   (asymmetric) JWT signing key, so the server can verify a user's session token
   locally with no network call using `getClaims()`. The user's role is carried
   in the token itself (via a Supabase Custom Access Token Hook that reads
   `profiles.role`), removing the per-request role query. Net effect: the
   ~975 ms auth floor collapses toward a single local check on every navigation
   and every API request. The optimistic middleware gate and the authoritative
   layout check both remain — they simply stop paying network round-trips.
2. **Move the dashboard aggregation into Postgres.** Replace the 110-request
   full-table scan + JavaScript counting with a single `dashboard_stats` RPC that
   does the `GROUP BY` in the database over the app-owned canonical columns that
   ADR 0001 already added and indexed (`country_id`, `industry_id`,
   `source_tokens`), plus `niche`. This is the identical pattern the
   `company_filter_options` RPC already uses. Measured proxy: **~1.1 s / 66 KB**
   vs **~9.8 s / ~10 MB** — about **9x** faster and ~150x less data. The result
   is then cached under a stable key so repeat views inside the TTL are instant.

The dashboard charts render the same numbers, and the app behaves identically
for a signed-in user; only the speed changes.

## User Stories

1. As an internal user, I want the Overview page to load quickly, so that opening
   the app doesn't make me wait ~10 seconds for charts.
2. As an internal user, I want switching from one tab to another (e.g. Overview →
   Team) to feel instant, so that moving around the app isn't a chore.
3. As an internal user, I want the Team, Activity, Tickets, and detail pages to
   stop paying an invisible ~1 second auth penalty on every visit, so that light
   pages feel light.
4. As an internal user, I want the companies and people list pages to also load
   faster, so that the auth overhead on their API calls stops adding up on top of
   the query work already being optimized separately.
5. As an internal user, I want the dashboard's Key Metrics, Data Distribution,
   Market Breakdown, and Recent Activity to show exactly the same values as
   before, so that a speed change never silently changes my numbers.
6. As an internal user, I want the date-range filter on the dashboard to keep
   working exactly as it does today, so that filtered views are still correct.
7. As an internal user, I want my sign-in, sign-out, and "who am I / what can I
   see" experience to be unchanged, so that faster auth never locks me out or
   changes my access.
8. As an admin, I want role-based visibility (admin/dev see Admin nav and pages,
   members don't) to keep working exactly as today, so that the auth change
   doesn't leak or hide the wrong sections.
9. As an admin, I want a role change I make for a teammate to take effect within
   a bounded, acceptable window, so that access management still works even
   though the role now travels in the token.
10. As a developer, I want the dashboard aggregation to run in Postgres via an
    RPC, so that adding ~90k more rows to the table doesn't linearly slow the
    home page.
11. As a developer, I want the new `dashboard_stats` RPC to group on the existing
    canonical columns from ADR 0001, so that the dashboard reuses the normalized
    forms already maintained by the import pipeline instead of re-normalizing in
    JavaScript.
12. As a developer, I want `getDashboard` to keep its exact return shape
    (`Dashboard`), so that the page component and charts need no changes and
    behavior is provably preserved.
13. As a developer, I want `getDashboard` wrapped with a stable cache key, so that
    dev-mode recompiles and production instances share and can invalidate the
    cache instead of scanning cold on nearly every navigation.
14. As a developer, I want session validation to use local `getClaims()`
    verification against the project's published JWKS, so that the middleware and
    DAL stop making a network call to the auth server on every request.
15. As a developer, I want the DAL's `getUser`, `requireUser`, `requireAdmin`,
    and `requireAdminOrDev` to keep their exact signatures and redirect behavior,
    so that every caller (layout, pages, API routes) is untouched and access
    control is provably unchanged.
16. As a developer, I want the user's role delivered as a JWT claim via a Custom
    Access Token Hook reading `profiles.role`, so that the per-request `profiles`
    query is removed from the hot path.
17. As a developer, I want a fallback path if a session token is still legacy
    HS256, so that the change is never slower than today during any transition.
18. As a developer, I want before/after latency captured with a repeatable
    benchmark, so that we can prove the improvement with real numbers rather than
    impressions.
19. As a maintainer, I want the change scoped so it does not touch the in-flight
    `companies` / `people` list-query optimization, so that the two efforts don't
    collide.
20. As a maintainer, I want a documented way to confirm session tokens are ES256
    in this project, so that the local-verification assumption is validated during
    implementation rather than assumed.

## Implementation Decisions

- **Measured baseline (2026-07-26, live DB).** companies = 109,756 rows;
  people = 14,187; profiles = 3. Single auth round-trip ~325 ms warm; per-nav
  auth floor ~975 ms (middleware `getUser` + layout `getUser` + `profiles`
  query). Dashboard cold load ~9.8 s (count 0.76 s + 110-page fan-out 9.0 s +
  JS agg 0.03 s, ~10 MB). DB-side GROUP BY proxy (`company_filter_options` over
  all rows) ~1.1 s / 66 KB. Full detail and method in
  `docs/reports/performance-findings.md`.

- **Behavior-preserving is the hard constraint.** Nothing a signed-in user sees
  or can do while using the app may change — only latency. The one acknowledged
  edge is mid-session role-change propagation (see below), which is an admin
  action outside a normal user session.

- **Dashboard aggregation moves DB-side via a new `dashboard_stats` RPC.** It
  accepts the same optional date-range bounds `getDashboard` accepts (`from`
  exclusive-`to` semantics preserved) and returns everything the `Dashboard`
  object needs: total companies, total people, and breakdowns for niches,
  sources, industries, and countries, plus the five most-recent companies. It
  computes counts with `GROUP BY` on the canonical columns ADR 0001 introduced
  (`country_id`, `industry_id`, `source_tokens` via unnest) and on `niche`,
  mirroring `company_filter_options`. Labels/casing that today come from JS
  helpers (`sourceLabel`, `normalizeCountry`, `titleCase`) are applied in the
  thin `getDashboard` mapping layer, not in SQL, to keep the display identical.

- **`getDashboard` keeps its exact interface.** It stops calling `fetchAllRows` +
  the JS aggregation loop and instead calls the RPC and maps the result into the
  unchanged `Dashboard` shape. The page component (`app/page.tsx`) and all chart
  components are untouched.

- **`getDashboard` gains a stable cache key.** `withTtlCache(..., 60_000,
  "dashboard")`, matching the `companies:base` / `people:base` pattern, so the
  cache survives dev recompiles and is invalidatable/shareable.

- **Session validation switches from network `auth.getUser()` to local
  `auth.getClaims()`** in both the middleware (`proxy.ts`) and the DAL
  (`lib/auth/dal.ts`). Verification is done locally against the project's
  published ES256 JWKS. `getClaims` degrades to a network check for any legacy
  HS256 token, so the path is never slower than today.

- **Role travels in the JWT via a Supabase Custom Access Token Hook.** A Postgres
  function reads `profiles.role` and injects a `user_role` claim into issued
  tokens; the DAL reads role from the claim instead of querying `profiles`. The
  DAL's public surface (`getUser` → `SessionUser`, plus `requireUser` /
  `requireAdmin` / `requireAdminOrDev`) is unchanged, so no caller changes.

- **Acknowledged behavioral delta and its bound.** A role changed for a user
  mid-session applies on their next token refresh (≈1 h or sooner) rather than
  instantly. This is acceptable for an internal tool and is an admin action, not
  part of a normal user session. Documented fallback if unacceptable: a
  short-TTL in-process cache of role-by-user-id (no JWT hook; role change visible
  within the TTL), which still removes the query from the hot path.

- **Out-of-scope guardrail.** This PRD does not modify the `companies` / `people`
  list queries (`getCompanies` / `getPeople` / their RPCs), which are being
  optimized in parallel. The dashboard change only adds a new read-only aggregate
  RPC and does not alter the canonical-column write path.

- **Static-shell / streaming (F3) is explicitly deferred.** Reducing forced-
  dynamic rendering may be worthwhile but requires validating against this Next
  version's docs and carries more risk; it is noted for a later PRD, not built
  here.

## Testing Decisions

- **What makes a good test here:** it asserts externally observable behavior —
  the numbers the dashboard shows and the access decisions the DAL makes — not
  internal mechanics like which SQL runs or whether verification was local vs
  networked. Tests run against the real Supabase database, consistent with this
  repo's prior art (`lib/import/push.test.ts`, `lib/data/companies-csv.test.ts`
  hit the live instance and clean up `__test-` prefixed rows in
  `beforeAll`/`afterAll`).

- **Primary test — dashboard parity.** The single most valuable test asserts that
  the RPC-backed `getDashboard` returns results equal to the current JS-scan
  implementation for the same inputs: total counts, and each breakdown's
  ids/labels/counts, for both the no-range case and a representative date range.
  This is the guarantee that "faster" did not change "what the user sees." The
  module under test is `getDashboard` (with the `dashboard_stats` RPC behind it),
  exercised against live data.

- **Secondary test — access-control parity for the DAL.** Verify that the
  claims-based `getUser` resolves the same `SessionUser` (id, email, role) that
  the current implementation does for a given session, and that
  `requireAdmin` / `requireAdminOrDev` still redirect/allow identically per role.
  Because these depend on real tokens, the practical form is an integration check
  around a decoded token plus the role-claim path, rather than mocking Supabase.

- **Modules the user should confirm for test coverage:** `getDashboard` (parity)
  is strongly recommended. The DAL auth change is recommended but harder to unit
  test end-to-end; at minimum the role-claim extraction and the redirect logic in
  `requireAdmin`/`requireAdminOrDev` should be covered.

- **Benchmark, not a unit test:** keep the `bench.mjs`-style before/after
  measurement as a documented, repeatable script so the latency win is provable,
  but it is not part of the automated suite.

## Out of Scope

- Any change to the `companies` / `people` list queries or their canonical-column
  write path (optimized separately, in flight).
- Reducing forced-dynamic rendering / adding a static shell or partial
  prerendering (F3) — deferred to a later PRD pending Next-version doc review.
- Parallelizing the company detail page's two sequential fetches (F8) — minor,
  and it touches the companies/people read path, so it is coordinated with the
  separate list work, not here.
- Building any new auth system, roles, or permissions — only the mechanism for
  validating the existing session and reading the existing role changes.
- Any user-visible UI change on the dashboard or elsewhere.

## Further Notes

- The Supabase project publishes an ES256 signing key at
  `/auth/v1/.well-known/jwks.json`, which is what makes local `getClaims()`
  verification viable; the anon/service *API keys* remain legacy HS256 but are
  irrelevant since they are not user session tokens. During implementation,
  decode one real logged-in session token and confirm its header is `alg: ES256`
  before relying fully on the local path.
- The dashboard's stale "~29k rows" comment should be corrected as part of this
  work — the table is ~109,756 rows and growing, which is the core reason the
  JS-side scan no longer scales.
- Full measurements, method, and the resolved auth-design rationale live in
  `docs/reports/performance-findings.md` (findings F1–F8 with per-item detail).
- Suggested sequencing for the resulting issues: (1) `getDashboard` cache key —
  one-line, zero-risk; (2) `dashboard_stats` RPC + `getDashboard` rewrite +
  parity test — isolated, ~9x win; (3) local `getClaims` validation + role-in-JWT
  hook — app-wide floor reduction; (4) benchmark capture to prove before/after.
