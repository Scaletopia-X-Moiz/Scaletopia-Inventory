Task 3 — Data Inventory Interface
Watch Loom
www.loom.com
https://www.loom.com/share/da8f6269c8c2475ca127ae5e085547cc
Background
We are building an internal web interface that gives our team visibility into our central Supabase data store —
all companies and people we have ever pulled for clients and campaigns. Right now if we want to filter , search,
or export this data, we have no tool. Everything is done manually.
This tool is for internal use today. The longer-term direction is to productize it and sell access to other agencies
who need the same thing — a lightweight internal data layer with filtering and export. Build it knowing that
direction exists. Quality and architecture matter .
A v1 version was built previously. You can review it for reference but you are not required to extend it. Make the
judgment call yourself on whether to start fresh or build on it.
What's in Supabase
API:
https://swfykpknnfunpapzoudn.supabase.co/rest/v1/
Key: ask Saqlain.
companies table
•
•
•
•
•
•
Core: company_name , domain , linkedin_url , industry , employee_count , city , state , country
Source: source (comma-separated — see important note below), source_id
Tags: tags array — see important note below
Domain health: quality_tier (tier
1 / tier
2 / tier
_
_
_
3), mx_provider , security_gateway , domain_status
Enrichment: custom_data JSONB — campaign-specific fields
(e.g. ideal_segment , competitor_1 , product_category )
last_updated timestamp
people table
•
•
•
•
Core: first_name , last_name , email , phone , linkedin_url , job_title
Status: email_status (ok / catch
_
all / invalid / unknown), phone_type (mobile / toll
_
free / landline)
Source + tags (same pattern as companies)
custom_data JSONB — same pattern
•
Foreign key: company_id → companies
Two things you need to know before building
These are non-obvious and aﬀect how you query and display data throughout the entire interface.
1. Tags are a flat array, not keyed.
Tags look like this: ["kynship", "dtc-beauty", "2026-06-01"]
Position 0 = client name. Position 1 = niche. Position 2 = date pulled. No prefixes, no keys.
When a company is pulled for a second campaign, new tags are appended — not replaced. So a company
pulled twice might have: ["kynship", "dtc-beauty", "2026-04-07", "health-wellness", "2026-06-01"]
When extracting niches from tags: filter out anything matching a date pattern (YYYY-MM-DD) and anything that
is a known client name. What's left is a niche.
2. The source column is intentionally comma-separated.
A company found via multiple providers will have: source = "aiark,blitz-api" or "aiark,apollo". This is by design.
Everywhere source is displayed or filtered, split on comma first. A company with source = "aiark,blitz-api"
should show two separate chips in the UI and match filters for either "aiark" or "blitz-api" independently. Never
display or filter on the raw combined string.
What to build
Overview page
•
Total companies count
•
Total people count
•
Niches breakdown: all niche values with company count per niche, sorted descending
•
Sources breakdown: all source tokens (split on comma) with company count per token, sorted descending
Companies page
List view with these filters (all multi-select dropdowns unless noted):
1.
Search — name or domain text search
2.
Niche — multi-select, extracted from tags
3.
Source — multi-select, from source column split on comma
4.
Industry — multi-select, from industry column
5.
Employee Size — range buckets: 1–10, 11–50, 51–200, 201–500, 500+
6.
Country — multi-select, from country column
Table columns: Company Name, Domain, Industry, Employees, Location (city + country), Source (one chip per
token), Quality Tier , Last Updated.
Rows clickable → Company Detail. CSV export of any filtered view.
Company Detail page
All core fields. Tags displayed as chips, rendered as-is.
For custom_data — apply these rules:
•Never show these keys regardless of
value: naics , aiark_id , industries , legal_name , ai_ark_approaches , pushed_to_clay , created_at , updated_at , c
ompany_type
•
Never show any key where the value is null, empty array, or empty string
•
If nothing passes those filters, show "No enrichment data"
People page
List view with these filters:
1.
Search — name or email
2.
Niche — same tag logic as Companies
3.
Source — same comma-split logic
4.
Country — from linked company
5.
Employee Size — from linked company's employee_count
6.
Industry — from linked company's industry
7.
Email — single-select: Any / Not Empty / Empty
8.
Phone — single-select: Any / Not Empty / Empty
9.
Email Status — multi-select: ok / catch
all / invalid / unknown
_
10.
Phone Type — multi-select: mobile / toll
free / landline
_
11.
Job Title — keyword text input. Comma-separated terms, case-insensitive substring match
against job_title.
"founder , CEO, owner" returns anyone whose title contains any of those words.
Note: filters 4, 5, and 6 require joining against the companies table.
Email Status badge: only render if email is not null or empty.
Rows clickable → Person Detail. CSV export of any filtered view.
Person Detail page
Show: full name, job title, email + status badge, phone + type badge, LinkedIn URL (clickable), source chips, tags
as chips.
Linked Company card: company name, domain, quality tier — clickable to that company's detail page.
Custom data: same blocklist rules as Company Detail, plus additionally hide: company_linkedin_id ,
connections_count , apollo_id , aiark_id , pushed_to_clay , created_at , updated_at.
Stack and approach
Your choice. No auth needed — internal only. No editing records, no pushing to Clay, no campaign
management — all out of scope.
Deliverable
Working interface, local or deployed to a simple host. When done: share a demo, a repo link, and a short written
summary of the architecture decisions you made and why.
QA before you say done
•Every filter on Companies and People pages works correctly against real Supabase data
•
•
•
•
•
Source always displays and filters as individual tokens, never the raw combined string
Niche filter returns correct results for companies with multiple niches in their tags
Custom data blocklist is respected — open a few company and person records and verify no blocked keys
appear
CSV export produces a clean file with correct columns and respects active filters
Person Detail linked company card navigates correctly to that company's detail page