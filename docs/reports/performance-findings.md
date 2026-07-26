# Performance findings — app-wide load & navigation latency

Date: 2026-07-26
Status: Draft findings (pre-PRD)
Scope note: The `companies` and `people` **list** queries are being optimized
separately (canonical columns / DB-side list — see ADR 0001 and recent commits)
and are **out of scope here**. Nothing below changes those table queries.
Context: internal-only app, links shared only within the team, so auth-token
freshness tradeoffs that would matter for a public app are acceptable here.

---

## Summary

Every navigation in the app pays a fixed latency floor that has nothing to do
with the page's own data — even a cheap page like `/team` is slow. On top of
that floor, the **home page** additionally scans the whole companies table and
aggregates in JavaScript. The fixes fall into two buckets:

1. **App-wide auth overhead** (F1–F3) — affects every tab and every API call.
2. **Home-page dashboard** (F4–F5) — behavior-preserving, big win, isolated.

Plus one that piggybacks on the list pages (F6) and two minor ones (F7–F8).

---

## Baseline measurements (measured 2026-07-26, live DB, from a dev machine)

Method: direct timed calls against the live Supabase project (Marseille edge),
plus a faithful replay of `fetchAllRows` + the dashboard JS aggregation
(`scratchpad/bench.mjs`). Absolute numbers include this machine's network RTT to
Supabase; a colocated production server would be lower, but the **ratios** hold.

| Metric | Measured | Notes |
| --- | --- | --- |
| `companies` row count | **109,756** | code comment says "~29k" — stale by ~4x |
| `people` row count | 14,187 | |
| `profiles` row count | 3 | the per-request role-lookup target |
| Single auth round-trip (`auth.getUser`) | ~325 ms warm / ~540 ms cold | network validation against GoTrue |
| **Per-navigation auth floor** | **~975 ms** | 3 serial round-trips: middleware `getUser` + layout `getUser` + `profiles` role query |
| Single companies scan page (1000 rows) | ~0.7 s, ~92 KB | dashboard pulls **110** of these |
| **Dashboard cold load (`getDashboard`)** | **~9,823 ms** | count 763 ms + 110-page parallel fan-out 9,031 ms + JS agg 29 ms; ~10 MB transferred |
| DB-side GROUP BY proxy (`company_filter_options` RPC, all rows) | **~1,100 ms, 66 KB** | faithful proxy for the proposed `dashboard_stats` RPC |

**Headline deltas the PRD should be measured against:**

- Dashboard data fetch: **~9.8 s → ~1.1 s (~9x)** by moving aggregation DB-side
  (F4), then effectively instant on cache hits (F5).
- Per-navigation auth floor: **~975 ms → one local check** by validating tokens
  locally and sourcing role from the token (F1/F2/F6). Eliminates ~2 of the 3
  serial round-trips app-wide.

---

## Resolved design decisions (was: open questions for grilling)

Verified directly against the environment, so no grilling session is needed:

- **Asymmetric JWT verification is available.** The project's JWKS endpoint
  (`/auth/v1/.well-known/jwks.json`) publishes a current **ES256** signing key.
  So `supabase.auth.getClaims()` can verify a user's access token **locally**
  against the cached JWKS with no network call. (The anon/service *API keys* are
  still legacy HS256 — irrelevant; they aren't user session tokens.) `getClaims`
  degrades gracefully: if a given session token is still HS256 it falls back to
  a network check, so the change is never *slower* than today. One runtime
  confirmation to do during implementation: decode a real logged-in session
  token's header and confirm `alg: ES256`.
- **Single authoritative validation.** Switch both the middleware (`proxy.ts`)
  and the layout DAL (`getUser`) from `auth.getUser()` (network) to
  `auth.getClaims()` (local). The middleware stays the optimistic gate; the DAL
  stays authoritative — both just stop paying a network round-trip.
- **Role without a per-request query.** Role lives in `profiles` today (3 rows),
  queried on every request. Recommended: add role to the JWT via a Supabase
  **Custom Access Token Hook** (Postgres function reading `profiles.role`), then
  `getClaims` returns it locally. Behavioral delta: a mid-session role change
  applies on next token refresh (≈1 h or sooner) instead of instantly. This is
  an admin action, not part of a normal user session, so it does **not** change
  "the way things work when a user is using the app." If even that delta is
  unacceptable, the fallback is a short-TTL in-process cache of the role keyed
  by user id (role change visible within the TTL) — no JWT change, still removes
  the query from the hot path.

**Non-negotiable constraint (from stakeholder):** none of these change what a
user sees or can do while using the app — only latency changes. Every item
below is behavior-preserving under normal use; the single edge (mid-session role
change propagation) is called out above with a fallback.

---

## F1 — Every navigation validates the auth token twice over the network

**Where:** `proxy.ts:41` (middleware) and `app/layout.tsx:31` → `lib/auth/dal.ts:19`.

**What happens:** `supabase.auth.getUser()` is not a local cookie read — it
sends a request to Supabase's Auth (GoTrue) server to validate the JWT. It runs:

- once in the middleware (`proxy.ts`), which matches essentially every request, and
- again in the root layout via `getUser()`.

`getUser` is wrapped in React `cache()`, but that only dedupes *within a single
render* — it does **not** span the middleware→render boundary, so these are two
genuinely separate network round-trips to the Auth server on every navigation,
serial and blocking first byte.

**Cost:** ~2 auth round-trips per navigation. At a typical 100–300ms each
(more if the Supabase region is distant), that's roughly **200–600ms of pure
auth overhead before the page starts fetching its own data** — on every tab.

**Fix (internal-only makes this safe):** validate the token signature locally
instead of round-tripping. Supabase's `getClaims()` with asymmetric JWT signing
keys verifies the token with no network call. Use local verification in the
middleware gate, and let the layout be the single authoritative check (or vice
versa) so there is **one** validation per navigation, not two.

**Behavior impact:** for a valid, unexpired token, identical. The only
difference is that a token revoked mid-session is noticed at next check/refresh
rather than instantly — irrelevant for an internal tool.

**Est. gain:** removes ~1 network round-trip (~200–400ms) from **every**
navigation and every API request.

---

## F2 — `profiles` role query on every request

**Where:** `lib/auth/dal.ts:27` inside `getUser()`.

**What happens:** after validating the user, `getUser()` runs a `profiles`
`select role` query on every request to resolve the role. The role changes
almost never.

**Fix:** carry `role` in the JWT (`app_metadata`) or a signed cookie set at
login, so `getUser` reads it from the already-decoded token. Role changes take
effect on next token refresh instead of instantly — fine for internal use.

**Est. gain:** removes 1 DB query per navigation.

---

## F3 — Whole route tree is forced dynamic; caching/prefetch buys nothing

**Where:** root layout reads `cookies()` (via `getUser`), and
`app/team/page.tsx:7`, `app/activity/page.tsx:7`, `app/tickets/page.tsx:9`,
`app/companies/[id]/page.tsx:16` all set `export const dynamic = "force-dynamic"`.

**What happens:** because the root layout accesses cookies, every route is
dynamically rendered per request. The `export const revalidate = 3600` on the
home page (`app/page.tsx:15`) is effectively dead code — nothing is served from
cache. Client-side `Link` navigation still triggers a full server RSC render
(middleware + layout auth + page) on every tab switch.

**Fix (lower priority / needs verification):** the static parts (sidebar shell,
topbar) don't depend on per-request data and could render once while only the
data streams in via Suspense. The exact mechanism (partial prerendering / cache
directives) must be checked against this Next version's docs
(`node_modules/next/dist/docs/`) per AGENTS.md — do not assume prior-version APIs.

**Est. gain:** shell renders instantly; only data-dependent sections block.
Smaller and riskier than F1/F4 — sequence it last.

---

## F4 — Home page scans the entire companies table and aggregates in JS

**Where:** `lib/data/dashboard.ts:81` (`fetchAllRows`) + the JS loop at
`dashboard.ts:108-119`.

**What happens:** `getDashboard` pulls **every companies row** across paginated
queries, then computes the niche / source / industry / country breakdowns in a
JavaScript loop. The row count is now **109,756** (measured 2026-07-26 — the
"~29k" in the code comment is stale by ~4x), i.e. **110 parallel 1000-row
pages, ~10 MB over the wire**. Measured cold cost: **~9.8 s** (count 0.76 s +
page fan-out 9.0 s + JS agg 0.03 s). The bottleneck is the connection-limited
110-request fan-out, not the CPU aggregation.

**Fix:** move the aggregation into Postgres with a `dashboard_stats` RPC that
does `GROUP BY` — exactly the pattern `getCompanyFilterOptions` already uses
(`company_filter_options` RPC, `companies.ts:583`). Crucially, ADR 0001 already
added and indexed the canonical columns this needs (`country_id`, `industry_id`,
`source_tokens`), so the RPC groups on pre-normalized, indexed columns and
returns a few hundred grouped rows instead of ~29k raw rows. **This does not
alter the companies list path** — it only adds a read-only aggregate RPC.

**Behavior impact:** none, if the SQL groups on the same canonical columns the
JS normalization produces (the canonical columns *are* that normalized output,
so parity is essentially free). Verify by asserting the RPC returns identical
breakdowns against live data before swapping in.

**Est. gain (measured proxy):** the `company_filter_options` RPC computes these
same GROUP BY counts over all 109,756 rows in **~1.1 s / 66 KB** vs the scan's
**~9.8 s / ~10 MB** — **~9x**, transferring ~150x less data. A dedicated
`dashboard_stats` RPC (only the 4 breakdowns + 2 counts + 5 recent rows) is
equal-or-faster, so ~1.1 s is a conservative upper bound. With F5's cache,
subsequent loads inside the TTL are effectively instant.

**Implemented (issue #27):** `dashboard_stats` RPC added
(`lib/data/dashboard-stats.sql`), `getDashboard` rewritten to call it
(`lib/data/dashboard.ts`). Measured via the repeatable benchmark
(`npm run bench:dashboard`, `scripts/bench-dashboard.ts`), 2026-07-26:

| | elapsed | payload |
|---|---|---|
| before (`fetchAllRows` + JS aggregation) | 5,479 ms | 49.2 KB |
| after (`dashboard_stats` RPC) | 868 ms | 61.1 KB |

~6.3x faster in this run — short of the ~9x / ~1.1s proxy above, and the
"before" leg itself ran under half the original ~9.8s cold measurement, so
this run's connection/cache conditions weren't a clean re-creation of the
original cold baseline. Re-run `npm run bench:dashboard` from a cold state
(fresh process, no warm connection pool) for a tighter before/after
comparison; the RPC's absolute cost (868 ms) is what matters for the current
implementation regardless. A parity test
(`lib/data/dashboard-parity.test.ts`) confirmed the RPC-backed output matches
the old JS-scan implementation, with two intentional, documented exceptions:
industry and country breakdown labels/grouping now use the canonical
`industry_id`/`countryLabel()` already used by `company_filter_options`,
fixing two pre-existing normalization bugs in the old per-row JS aggregation
(e.g. `;`- vs `,`-delimited industry variants were previously counted as
separate buckets).

---

## F5 — `getDashboard` cache has no stable key (cold scan on nearly every dev nav)

**Where:** `lib/data/dashboard.ts:143` — `withTtlCache(getDashboardUncached, 60_000)`
is called **without** the third `cacheKey` argument.

**What happens:** per the comment in `cache-with-ttl.ts:11-17`, without a
`cacheKey` the cache is a module-scope `Map` that `next dev` discards on every
HMR recompile, so the 29k-row scan feels "cold" on nearly every local
navigation. The `/companies` and `/people` lists were given stable keys
(`companies:base` / `people:base`) for exactly this reason; the dashboard was
missed.

**Fix:** pass a stable key, e.g. `withTtlCache(getDashboardUncached, 60_000, "dashboard")`.
One line. (Once F4 lands, the underlying fetch is cheap anyway, but the key also
makes the cache invalidatable/shareable and fixes dev-mode coldness immediately.)

**Est. gain:** eliminates the repeated cold full-table scan during development;
in production makes the cache explicit and invalidatable.

---

## F6 — Middleware auth round-trip taxes every API call on the list pages

**Where:** `proxy.ts` matcher (`proxy.ts:62-65`) covers `/api/*`.

**What happens:** the companies/people list pages fetch via API routes
(`/api/companies/results` + `/api/companies/filter-options`, raced in parallel).
Each of those API calls independently pays the middleware `auth.getUser()`
network round-trip (F1) — so viewing a list costs the auth round-trip on the
page nav **plus** one per API request. This is separate from the table query
work you're already optimizing and does not touch those tables.

**Fix:** the F1 change (local JWT verification in middleware) covers this
automatically — every API request stops paying a network auth round-trip.

**Est. gain:** removes ~200–400ms from each `/api/*` request on the list pages
(and everywhere else), stacking with the DB-side list work.

---

## F7 — Command palette fetches `/api/niches` on open (minor)

**Where:** `components/shared/command-palette.tsx:89-95` → `app/api/niches/route.ts`
→ `getCompanyFilterOptions()`.

**What happens:** opening ⌘K triggers a niches fetch. It already routes through
the DB-side `company_filter_options` RPC (not a scan), and is fetched once per
session (guarded by `niches.length > 0`), so this is mostly fine. Optional: it
still pays the F6 middleware auth round-trip, and could be prefetched on hover.

**Est. gain:** small; resolve as a side effect of F6. No dedicated work needed.

---

## F8 — Company detail page runs two data fetches sequentially (minor, related)

**Where:** `app/companies/[id]/page.tsx:24-27` — `await getCompanyDetail(id)`
then `await getPeopleByCompanyId(company.id)`.

**What happens:** the two queries run back-to-back instead of in parallel.
`getPeopleByCompanyId` only needs the id (already known from params), so they
could `Promise.all`. Touches the companies/people read paths, so treat as
**related / optional** and coordinate with the in-flight table work.

**Est. gain:** ~1 round-trip off the detail page load. Small.

---

## Suggested sequencing

1. **F5** — one-line cache key. Immediate dev-speed relief, zero risk.
2. **F4** — DB-side dashboard RPC. Biggest home-page win, behavior-preserving,
   isolated, reuses ADR 0001's canonical columns + the existing RPC pattern.
3. **F1 + F2 + F6** — single auth validation + role from JWT. One change,
   removes a network round-trip (and a query) from **every** navigation and API
   call. Safe because the app is internal-only.
4. **F3** — static shell / streaming. Lower priority, needs Next-version doc
   check first.
5. **F8** — parallelize detail-page fetches, only alongside the table work.
