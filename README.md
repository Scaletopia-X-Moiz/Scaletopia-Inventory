<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-000000?style=for-the-badge&logo=nextdotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Supabase-PostgreSQL-3FCF8E?style=for-the-badge&logo=supabase&logoColor=white" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" />
</p>

# Scaletopia Inventory

**Data-enrichment and lead-management dashboard for browsing, normalizing, filtering, and pushing companies & people records to external platforms.**

Inventory sits on top of a raw, messy enrichment database — records arrive from many sources with inconsistent casing, aliases, and delimiter conventions — and gives operators a single interface to search, filter, deduplicate, and route that data to GHL, EmailBison, and Clay without ever touching SQL.

---

## How It Works

```
Raw enrichment data (many sources, inconsistent formats)
        |
        v
  Canonical normalization        Virtual columns
  (country, industry, source     let operators filter on
   normalized in TypeScript,       raw enrichment fields
   cached to DB columns)           on demand, view-only
        |                                |
        v                                v
  +-----------+   +-----------+   +-----------+   +-----------+
  |  Facets   |   | Companies |   |  People   |   |  Import   |
  | (scoped   |   |   table   |   |   table   |   | pipeline  |
  |  counts)  |   |           |   |           |   |           |
  +-----------+   +-----------+   +-----------+   +-----------+
        |                |                |                |
        v                v                v                v
              Push to GHL / EmailBison / Clay
              (results tracked in platform_pushes)
```

## Features

| Module | What it does |
|---|---|
| **Canonical Normalization** | Raw fields (country, industry, source) are normalized in TypeScript and cached to real DB columns so Postgres can filter/aggregate directly — TS stays the single source of truth |
| **Faceted Filtering** | Per-dimension counts (niche, source, industry, country, email status, phone type) that respect every *other* active filter without zeroing out their own options |
| **Virtual Columns** | On-demand, view-only columns over any enrichment field inside `custom_data`, with type inferred by sampling (Text / Number / Boolean / List / Date) and user-overridable |
| **Companies & People Tables** | Full-featured data grids with search, filter, sort, and bulk selection across large datasets |
| **Push to GHL** | Create-or-update contact + tag in GoHighLevel, triggerable from either the People or Companies table (company-level push resolves to the same People-level action) |
| **Push to EmailBison** | Two independent actions — add lead to workspace, and attach to a campaign — mirroring EmailBison's own enrichment shape rather than collapsing them |
| **Push to Clay** | Send the current filtered view to a Clay webhook (URL entered per-device at push time) for downstream enrichment workflows |
| **Email & Phone Verification** | Integrated verification via Clearout and MillionVerifier |
| **Import Pipeline** | Backfill and seed scripts for bringing new client datasets in cleanly, with canonical-column backfill for historical rows |
| **Activity & Push History** | Full audit trail of pushes and record activity per client |
| **Ticketing** | Lightweight internal ticket tracking tied to client records |

## Architecture

```
app/                      Next.js App Router
  companies/               Companies table + filters
  people/                  People table + filters
  clients/                 Client/campaign management
  import/                  Data import UI
  push-activity/           Live push activity feed
  push-history/            Historical push records
  activity/                Record-level activity log
  tickets/                 Internal ticketing
  team/                    Team/user management
  auth/                    Authentication flows
  api/                     Route handlers (companies, people, import,
                            push-jobs, push-field-mappings, emailbison,
                            niches, search, warm, internal)

lib/
  data/                    Canonical normalization (normalizeCountry,
                            normalizeIndustry, normalizeSourceTokens)
  import/                  Import + backfill scripts
  push/                    Push orchestration
  ghl/                     GoHighLevel client
  emailbison/              EmailBison client
  clay/                    Clay webhook integration
  verify/                  Verification orchestration
  clearout-phone/          Clearout phone verification client
  millionverifier/         MillionVerifier email verification client
  clean-names/             Name normalization utilities
  auth/                    Session/auth helpers
  supabase/                Supabase client + query helpers

supabase/
  migrations/              SQL schema migrations
```

## Quick Start

### Prerequisites

- Node.js 18+
- A Supabase project

### 1. Clone and install

```bash
git clone https://github.com/Scaletopia-X-Moiz/Scaletopia-Inventory.git
cd Scaletopia-Inventory
npm install
```

### 2. Configure

```bash
cp .env.example .env.local
```

```env
# .env.local
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

### 3. Run

```bash
npm run dev
```

The **"Push to Clay"** toolbar action pushes the current Companies filter view to a Clay webhook. The webhook URL is entered in the UI at push time (remembered per-device), not stored as an environment variable — every company in the current view is sent on each push, and Clay dedupes on its side.

## Scripts

```
dev                          start development server
build                         production build
test                           run test suite (Vitest)
lint                            run ESLint
backfill:canonical-columns              backfill canonical columns on companies
backfill:canonical-columns-people       backfill canonical columns on people
seed:clients                            seed client/campaign records
audit:niche-tagging                     audit niche-tag coverage
verify:auth-hook                        verify the Supabase auth hook
bench:dashboard                         benchmark dashboard query performance
```

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Server Components) |
| Language | TypeScript |
| Database | Supabase (PostgreSQL) |
| Styling | Tailwind CSS 4, Radix UI |
| Testing | Vitest |
| Email verification | MillionVerifier |
| Phone verification | Clearout |
| CRM integrations | GoHighLevel, EmailBison, Clay |

---

<p align="center">
  Built for teams managing large, multi-source lead datasets that need to stay clean, filterable, and routable.
</p>
