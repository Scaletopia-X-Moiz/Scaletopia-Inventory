# Code Review Issues

## 1. Bucket chip click silently ignored when custom range is active

**File:** `components/companies/filter-slip.tsx:127` (same pattern in `components/people/filter-slip.tsx:161`)

`toggle("employee", id)` builds the new URL from `searchParams.toString()`, which still contains `empmin`/`empmax`. The mutator only touches the `employee` param — it never deletes `empmin` or `empmax`. `setEmpMin("")`/`setEmpMax("")` clear React state but not the URL. The data layer always prioritizes custom range over buckets (`if (employeeMin != null) ... else if (employeeBucket)`), so the bucket is silently ignored.

**Fix:** Inside the `onToggle` handler, also call `params.delete("empmin"); params.delete("empmax")` within the `navigate` callback before toggling the bucket.

---

## 2. NaN from partial numeric input silently breaks the employee filter

**File:** `lib/data/companies-search-params.ts:11`, `lib/data/people-search-params.ts:22`

`employeeMin: empMin ? Number(empMin) : undefined` — a non-empty non-numeric string (e.g. `"1e"`) is truthy, so `Number("1e") = NaN` is assigned. `NaN != null` is `true`, so the branch fires. In the companies path, `q.gte("employee_count", NaN)` is passed to PostgREST (likely returns 0 results). In the people path, `count < NaN` is always `false`, so every record passes the filter — the full unfiltered dataset is returned.

**Fix:** `Number.isFinite(Number(empMin)) ? Number(empMin) : undefined`

---

## 3. FilterSlipClient crashes on any API error response

**File:** `components/companies/filter-slip-client.tsx:33` (same in `components/people/filter-slip-client.tsx:36`)

`fetch(...).then(r => r.json()).then(data => setOptions(data))` — no `r.ok` check. A 500 response with a JSON error body (e.g. `{"error":"db unavailable"}`) resolves `r.json()` successfully and calls `setOptions({error:"..."})`. On the next render `options.niches` is `undefined`, and `toOptions(options.niches)` → `undefined.map(...)` throws a `TypeError`. The `.catch(()=>{})` never fires because the promise resolved.

**Fix:** Add `if (!r.ok) throw new Error(r.status.toString())` before `.json()`.

---

## 4. People CSV export silently drops city and state

**File:** `lib/data/people-csv.ts:5`

`PersonListRow` gained `city` and `state` fields in this diff, but `HEADERS` and `toCsvRow` were never updated. Both fields are omitted from every exported CSV with no warning.

**Fix:** Add `"City"` and `"State"` to `HEADERS` and map `row.city ?? ""` / `row.state ?? ""` in `toCsvRow`.

---

## 5. Companies table locationOf ignores the new state field

**File:** `components/companies/companies-table.tsx:17`

`locationOf` is still `[row.city, row.country].filter(Boolean).join(", ")`. `CompanyListRow` gained `state` in this diff but it is never rendered in the table. A US company with `city="Austin"`, `state="TX"` shows "Austin, United States" instead of "Austin, TX, United States".

**Fix:** Update to `[row.city, row.state, row.country].filter(Boolean).join(", ")`.

---

## 6. Stale `now` frozen in 1-hour cached DashboardSections

**File:** `app/page.tsx:19`

`const now = new Date()` is computed inside `DashboardSections`, which is an async server component under `export const revalidate = 3600`. `now` is serialized into the RSC payload and cached. `RecentTable` uses it for `timeAgo(r.createdAt, now)` — relative timestamps drift silently for up to one hour until the cache revalidates.

**Fix:** Either remove the `now` prop and call `new Date()` inside `RecentTable` itself (client-side), or accept the staleness given the 1-hour revalidation window.

---

## 7. router.push per keystroke pollutes browser history

**File:** `components/companies/filter-slip.tsx:31` (same in `components/people/filter-slip.tsx`)

`navigate()` calls `router.push(...)` — not `router.replace`. Every character typed into any filter input (search, empMin, empMax, job title) creates a browser history entry. Typing "1000" into empMin creates 4 entries; pressing Back navigates through each intermediate value rather than leaving the page.

**Fix:** Change `router.push(...)` to `router.replace(...)` inside `navigate()`.

---

## 8. toFriendlyLabel duplicates humanizeSlug, with weaker acronym handling

**File:** `lib/data/source.ts:39`

`toFriendlyLabel` (split on `-`/`_`, title-case each word) duplicates `humanizeSlug` from `lib/utils.ts`, which does the same but also applies `KNOWN_ACRONYMS`. A source id like `"b2b-saas"` renders as `"B2b Saas"` via `toFriendlyLabel` but `"B2B SaaS"` via `humanizeSlug`.

**Fix:** Delete `toFriendlyLabel`; change `sourceLabel` to call `humanizeSlug` directly.
