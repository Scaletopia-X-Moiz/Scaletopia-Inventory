/**
 * Content for the Help / SOPs page: the Data Inventory Interface Playbook.
 *
 * Text is taken verbatim from the playbook; only em dashes have been replaced
 * with colons, commas, semicolons or sentence breaks. Backticks in text render
 * as inline code.
 *
 * Section ids, titles and Loom URLs live in `help-sections.ts`; this module
 * only supplies the prose for each id.
 */

import { SECTION_META, type HelpSectionMeta } from "./help-sections";

export type ListItem = string | { text: string; sub?: string[] };

export type Block =
  | { type: "h"; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: ListItem[] }
  | { type: "ol"; items: ListItem[] }
  | { type: "note"; text: string }
  | { type: "code"; text: string }
  | { type: "table"; head: [string, string]; rows: [string, string][] };

export type HelpSection = HelpSectionMeta & { blocks: Block[] };

const BLOCKS: Record<string, Block[]> = {
  "overview-key-highlights": [
    { type: "h", text: "Purpose & Core Problems It Solves" },
    { type: "h", text: "Why We Built This" },
    {
      type: "p",
      text: "We source data from dozens of tools, store it across 100+ Clay workbooks, enrich it through multiple platforms, verify it, and push it to campaigns, all while losing track of what we have, where it lives, and what it cost us. This interface centralizes everything.",
    },
    {
      type: "ul",
      items: [
        "We source companies from Apollo, AI-Ark, Blitz, Google Maps, Store Leads",
        "We enrich contacts via Blitz, GetLeads, QuickEnrich, LeadMagic, Prospeo",
        "We verify via MillionVerifier, ClearOutPhone, Icypeas",
        "We push to campaigns via EmailBison and GHL",
      ],
    },
    { type: "h", text: "Problem 1: Centralization" },
    {
      type: "p",
      text: "Right now, our data is scattered across 100+ Clay workbooks. Only the person who built a specific list can find it. Everyone else is blind.",
    },
    {
      type: "p",
      text: "The Data Inventory pulls everything from all of these into one standard format, with source identifiers, timestamps, and push history, so anyone on the team can find, filter, and use the data without needing to know which Clay workbook it's in.",
    },
    {
      type: "p",
      text: "A GTM Engineer can run their entire campaign operations from this interface, except for the actual sourcing (Apollo/AI-Ark UI) and enrichment (Clay). Those still happen externally, but the data flows in here.",
    },
    { type: "h", text: "Problem 2: TAM Visibility" },
    {
      type: "p",
      text: "We've been running this agency since 2022. We have a clear ICP. Yet we still can't answer \"how much data do we have for this niche?\" without spending an hour hunting through Clay.",
    },
    {
      type: "ul",
      items: [
        "GTM Strategists ask this constantly in CDS calls: how much data do we have left for this niche? Is it enough for another month of campaigns?",
        "This dashboard answers that in seconds: apply filters by niche, qualification status, email status, phone type, and see your total instantly",
      ],
    },
    {
      type: "note",
      text: "Note: The inventory only shows data that's been imported into it. It is not a live feed from Apollo or AI-Ark. The more we feed it, the more accurate the TAM picture becomes.",
    },
    { type: "h", text: "Problem 3: Launch Friction" },
    {
      type: "p",
      text: "We get last-minute campaign launches constantly: copy changes, targeting pivots, client requests. Switching from one niche to another currently means starting from scratch: re-source, re-enrich, re-verify, re-import.",
    },
    {
      type: "p",
      text: "Even when we already have the data, it's buried in Clay to the point where it's faster to rebuild the list from scratch than to find and reuse what we have. That is the problem.",
    },
    { type: "p", text: "This interface removes that friction:" },
    {
      type: "ol",
      items: [
        "Filter by the niche you need",
        "Verify emails/phones in one click",
        "Push directly to EmailBison or GHL from the interface",
        "Launch",
      ],
    },
    {
      type: "p",
      text: "Last-minute campaigns still aren't ideal, but we can now accommodate them without the full sourcing cycle.",
    },
    { type: "h", text: "Problem 4: Cost & Repeated Effort" },
    {
      type: "p",
      text: "We have a narrow ICP. Most of our clients target e-commerce brands and local businesses, the same niches, over and over. Yet every campaign we:",
    },
    {
      type: "ul",
      items: [
        "Re-scrape the same companies (costs scraping credits)",
        "Re-clean and re-qualify them (costs AI credits)",
        "Re-enrich contact information (costs enrichment platform credits)",
        "Re-enrich custom data points (costs AI credits again)",
        "Re-verify emails and phones (costs verification credits)",
      ],
    },
    {
      type: "p",
      text: "More than half of our data costs go into re-doing work we've already done, because the original data is too scattered to reuse.",
    },
    {
      type: "p",
      text: "Once data is in the inventory, it stays. We enrich it once, verify it once, and reuse it across campaigns and clients. We still source new data (markets change, people leave jobs), but we stop paying twice for the same list.",
    },
    { type: "h", text: "Short Term vs Long Term" },
    {
      type: "p",
      text: "Short term: The inventory starts empty. Benefits are limited to cleaner import operations and removing push friction for GHL/EmailBison.",
    },
    {
      type: "p",
      text: "Long term: Every list we build gets imported here. Every client, every niche, every enrichment. Over time it becomes the source of truth, a hub where launching a campaign starts with a filter, not a full sourcing run.",
    },
    {
      type: "p",
      text: "Every time we feed data in, the inventory gets more valuable. The loop: source → enrich → verify → store → reuse.",
    },
    {
      type: "p",
      text: "Checkout the SOPs below to understand each function and learn them in detail.",
    },
  ],
  "high-level-walkthrough": [
    {
      type: "p",
      text: "A quick run-through of every section in the interface. Watch this first before the detailed SOPs.",
    },
    { type: "h", text: "Overview Page" },
    { type: "p", text: "The landing page of the interface. Once data is imported, it shows:" },
    {
      type: "ul",
      items: [
        "Total companies and people in the inventory",
        "Total niches (e.g., HVAC, skincare brands, law firms)",
        "Sources breakdown: how many companies came from each provider (AI-Ark, Apollo, etc.)",
        "Catalog distribution: companies by niche or by source, shown as a chart",
        "Top industries by volume",
        "Geography: which countries your data comes from",
        "Recently added companies",
      ],
    },
    {
      type: "p",
      text: "Use the time filter (top right) to scope all of this to a specific date range.",
    },
    { type: "h", text: "Companies Page" },
    {
      type: "p",
      text: "All companies stored in the inventory. Filters: niche, source, industry, employee size, country, email status, phone type, contact info presence, push status per client.",
    },
    {
      type: "p",
      text: "Actions available: Re-verify Email, Clean Company Names, Push to EmailBison, Push to EmailBison Campaign, Export as CSV.",
    },
    { type: "h", text: "People Page" },
    {
      type: "p",
      text: "All contacts stored in the inventory. Same filters as Companies plus job title keyword search. Linked to their parent company; company-level filters (industry, employee size, country) work here too.",
    },
    {
      type: "p",
      text: "Actions available: Re-verify Email, Re-verify Phone, Push to GHL, Push to EmailBison, Push to EmailBison Campaign, Export as CSV.",
    },
    { type: "h", text: "Import" },
    {
      type: "p",
      text: "Where all data enters the inventory. Supports company lists and people lists. Drag and drop a CSV, select the source, map columns, add metadata (client, niche, date), preview the import, and confirm.",
    },
    {
      type: "p",
      text: "Full import history is visible here: who imported what, when, and from which source.",
    },
    { type: "h", text: "Tickets" },
    {
      type: "p",
      text: "Bug reports and feature requests. If something isn't working or you want an improvement, raise a ticket here. Each ticket shows its current status (open, in progress, done).",
    },
    { type: "h", text: "Push Activity" },
    {
      type: "p",
      text: "Every push to GHL or EmailBison runs as a background job. You can see all active and completed pushes here: client, platform, niche, total selected, created, updated, failed, and failure reasons. Each push has a \"View Contacts\" or \"View Companies\" button that applies the exact filters to show you what was pushed.",
    },
    { type: "h", text: "Push History" },
    {
      type: "p",
      text: "Row-by-row log of every individual lead pushed to any platform: who, where, when.",
    },
    { type: "h", text: "Activity" },
    {
      type: "p",
      text: "Full audit log of everything that happens in the interface: invites, removals, imports, pushes, tickets. Every action is logged with the user, action type, and timestamp.",
    },
    { type: "h", text: "Team" },
    {
      type: "p",
      text: "Invite new team members by email. Assign roles (Member, Admin, Developer). Remove members when needed.",
    },
    { type: "h", text: "Clients" },
    {
      type: "p",
      text: "All client credentials stored in one place: GHL API key, GHL Location ID, EmailBison API key, EmailBison Workspace ID. Add new clients here when onboarding. Update credentials here when rotating API keys. No code changes needed.",
    },
    { type: "h", text: "Help / SOPs" },
    {
      type: "p",
      text: "All the process SOPs (the ones you're reading now) will live here, linked to their Looms.",
    },
    { type: "h", text: "Global Search (Cmd+K / Ctrl+K)" },
    {
      type: "p",
      text: "The fastest way to navigate. Press Cmd+K (Mac) or Ctrl+K (Windows) from anywhere in the interface. Search by:",
    },
    {
      type: "ul",
      items: [
        "Company name, domain, or niche: jumps to that company",
        "Email address: finds the exact person record",
        "Any keyword: shows matching companies and people instantly",
      ],
    },
    { type: "h", text: "Dark / Light Theme" },
    {
      type: "p",
      text: "Toggle between dark and light mode from the top-right settings area. Both are fully supported.",
    },
  ],
  "how-to-import-data": [
    {
      type: "p",
      text: "Import is where all data enters the inventory. Every list you build, companies or people, gets imported here first.",
    },
    { type: "h", text: "Importing Companies" },
    {
      type: "ol",
      items: [
        "Get your CSV export from AI-Ark, Apollo, or wherever you sourced the list",
        "Go to Import in the left nav",
        "Drag and drop the CSV (or click to upload)",
        "Select the source: choose the platform this data came from (AI-Ark, Apollo, Blitz, Google Maps, etc.)",
        {
          text: "Map the columns: the interface auto-maps most fields. Go through each one to confirm:",
          sub: [
            "Company name, domain, LinkedIn URL, industry, employee count, city, state, country, phone, description, founded year, revenue, technologies",
            "Skip any columns you don't need by selecting \"Ignore\"",
          ],
        },
        {
          text: "Add metadata:",
          sub: [
            "Client: the client this list is for (e.g., Scaletopia, Kynship)",
            "Niche: the niche/category (e.g., HVAC, Skincare Brands, Law Firms)",
            "Date: select today's date (auto-populated)",
          ],
        },
        {
          text: "Click Next. The interface runs a pre-flight check:",
          sub: [
            "Shows how many records will be created (new), updated (already exist), and failed",
            "Deduplication happens automatically by domain",
          ],
        },
        "Confirm and Push",
      ],
    },
    {
      type: "p",
      text: "Import is fast: a few thousand companies import in seconds.",
    },
    { type: "h", text: "Importing People" },
    {
      type: "p",
      text: "Same flow as companies, but select the People tab before uploading.",
    },
    {
      type: "p",
      text: "People lists usually include company data as well. Map both, and the interface will update the company record if it already exists, and create a new one if not.",
    },
    { type: "p", text: "Key columns to map for people:" },
    {
      type: "ul",
      items: [
        "First name, last name, email, phone, job title, LinkedIn URL",
        "Company name, company domain, company LinkedIn URL, employee count",
      ],
    },
    {
      type: "p",
      text: "After import, people appear in the People section with all filters available.",
    },
    { type: "h", text: "Import History" },
    {
      type: "p",
      text: "After every import, an entry is created in the import history: who imported it, from which source, when, and how many records were created/updated/failed. Check this if you need to confirm a past import.",
    },
    { type: "h", text: "Tips" },
    {
      type: "ul",
      items: [
        "Always review the column mapping before confirming. The auto-map is usually right but double-check LinkedIn URL, phone, and custom columns.",
        "Import companies first, then people from the same list; it ensures people are correctly linked to their parent company.",
        "If a company already exists in the inventory (matched by domain), the import will update it rather than create a duplicate.",
      ],
    },
  ],
  "how-to-filter-clean-verify": [
    { type: "h", text: "Filtering" },
    { type: "h", text: "Company Filters" },
    { type: "p", text: "Available on the Companies page:" },
    {
      type: "ul",
      items: [
        "Niche: multi-select. Extracted automatically from tags (anything that isn't a date or a client name)",
        "Source: multi-select. Split by provider: AI-Ark, Apollo, Blitz, etc.",
        "Industry: multi-select from the industry column",
        "Employee Size: range buckets: 1-10, 11-50, 51-200, 201-500, 500+",
        "Country: multi-select",
        "Email Status: after verification: ok / catch-all / invalid / unknown",
        "Has Contact Info: filter to only companies with email (not empty) or phone (not empty)",
        "Push Status: per client. Select a client and filter by \"Not yet pushed to GHL\" or \"Already pushed to GHL\" (same for EmailBison). Use this to find net-new leads before a push",
      ],
    },
    { type: "h", text: "People Filters" },
    { type: "p", text: "Same as above plus:" },
    {
      type: "ul",
      items: [
        "Job Title: keyword search. Enter comma-separated terms (e.g., `founder, CEO, owner`). Returns anyone whose title contains any of those words (case-insensitive)",
        "Phone Type: mobile / toll_free / landline",
        "Email Status: ok / catch-all / invalid / unknown",
      ],
    },
    { type: "h", text: "Excluding a Filter Value" },
    {
      type: "p",
      text: "To exclude rather than include a value, click the minus (−) button next to any selected filter value. This removes that value from results, useful for excluding a specific source, niche, or country.",
    },
    { type: "h", text: "Global Search (Cmd+K)" },
    {
      type: "p",
      text: "Press Cmd+K (Mac) or Ctrl+K (Windows). Type a niche, company name, email, or domain. It will:",
    },
    {
      type: "ul",
      items: [
        "Show matching records across companies and people",
        "Clicking a niche result auto-applies the niche filter on the Companies page",
      ],
    },
    { type: "h", text: "Cleaning Company Names" },
    {
      type: "p",
      text: "Before pushing to any platform, clean the company names to remove legal suffixes, extra formatting, and noise.",
    },
    {
      type: "ol",
      items: [
        "Apply your filters first: only clean the companies you're going to use. Cleaning runs an AI prompt for each record, so avoid running it on the full inventory",
        "Click Clean (top of Companies page)",
        "The AI runs in the background, so you can continue other tasks",
        "Cleaned names appear in the Clean Company Name column",
        "If any names didn't clean correctly, flag them in the Tickets section",
      ],
    },
    { type: "h", text: "Verifying Emails" },
    { type: "p", text: "On companies:" },
    {
      type: "ol",
      items: [
        "Filter to only companies where email is not empty",
        "Click Re-verify Email",
        "Runs in the background via MillionVerifier",
        "Email status updates to: `ok`, `catch-all`, `invalid`, or `unknown`",
        "After verification, filter by email status = ok to get your clean send list",
      ],
    },
    { type: "p", text: "On people: same process, available on the People page." },
    { type: "h", text: "Verifying Phone Numbers" },
    {
      type: "p",
      text: "Available on the People page only (not companies, since SMS campaigns use people, not company-level phones).",
    },
    {
      type: "ol",
      items: [
        "Filter to only people where phone is not empty",
        "Click Re-verify Phone",
        "Runs via ClearOutPhone in the background",
        "Phone type updates to: `mobile`, `toll_free`, or `landline`",
        "Only push mobile and toll_free to GHL; landlines are automatically skipped during push",
      ],
    },
    { type: "h", text: "Virtual Columns (Custom Enrichment Filtering)" },
    {
      type: "p",
      text: "Enrichment data from Clay lives in the `custom_data` field and isn't visible as a regular column. To filter on it:",
    },
    {
      type: "ol",
      items: [
        "Click Add Column on the Companies or People page",
        "Select a key from the `custom_data` field (e.g., `qualification_status`, `lead_score`, `ideal_segment`)",
        "Choose its type: Text / Number / Boolean",
        "The column appears in the table and a filter control appears in the sidebar",
        "Filter by contains, equals, is empty, greater than, etc.",
      ],
    },
    {
      type: "p",
      text: "Virtual columns are frontend-only: nothing is written to the database. After pushing or exporting, you'll be prompted to remove them from view.",
    },
    { type: "h", text: "Exporting" },
    {
      type: "p",
      text: "Click Export CSV on any filtered view (Companies or People). The export includes all visible columns plus `custom_data` fields. Use this to hand off data, import into Clay, or archive.",
    },
  ],
  "how-to-push-to-clay": [
    {
      type: "p",
      text: "Once companies or people are imported into the inventory, push them to Clay to run enrichments: qualification, custom data points, find people, email/phone enrichment, and anything else your Clay template handles.",
    },
    { type: "h", text: "Method 1: Export CSV → Import in Clay (Recommended)" },
    { type: "p", text: "This is the fastest and most reliable method." },
    {
      type: "ol",
      items: [
        "Filter your data in the inventory: select the niche, client, and any other filters",
        "Click Export CSV",
        "Go to your Clay workbook (duplicate the template first if starting a new campaign)",
        "Import the CSV directly into the relevant Clay table (Import Accounts or Import People)",
        "Clay processes and enriches from there",
      ],
    },
    {
      type: "p",
      text: "This takes 2-3 seconds to export and imports instantly in Clay. It is 10-100x faster than the push-to-Clay webhook method.",
    },
    { type: "h", text: "Method 2: Push to Clay (Webhook)" },
    {
      type: "p",
      text: "The interface has a built-in \"Push to Clay\" button that sends records directly via webhook. It works but is slower, limited by Clay's inbound rate limits, which we can't control.",
    },
    {
      type: "p",
      text: "Use this method only when you don't want to download and re-upload a CSV.",
    },
    { type: "p", text: "Steps:" },
    {
      type: "ol",
      items: [
        "In your Clay workbook, copy the webhook URL from the Import tab",
        "In the inventory, apply your filters",
        "Click Push to Clay → paste the webhook URL → push",
        "Records will appear in Clay progressively as they're received",
      ],
    },
    {
      type: "note",
      text: "Note: For large lists (1,000+ records), the export + CSV import method is significantly faster.",
    },
    { type: "h", text: "When to Push to Clay" },
    {
      type: "ul",
      items: [
        "After a fresh company import, to run company enrichment (domain health, qualification, ideal segment, etc.)",
        "After company enrichment, to find people via Clay's Find People feature",
        "For any custom AI enrichment points defined in the campaign's lead request",
      ],
    },
  ],
  "how-to-push-back-from-clay": [
    {
      type: "p",
      text: "After you've run enrichments in Clay (qualification, custom data points, AI scoring, etc.), push that enrichment data back into the Data Inventory so it's permanently stored and filterable, without having to re-run Clay again next time.",
    },
    { type: "h", text: "How It Works" },
    {
      type: "p",
      text: "The Clay template includes a Post to Supabase node at the end of the enrichment flow. This node sends the enrichment data back to the inventory using the domain as the unique identifier to match the correct company or person record.",
    },
    { type: "h", text: "Setup in Clay" },
    {
      type: "ol",
      items: [
        "Open the Post to Supabase node in your Clay template",
        "In the domain field, map the company domain column: this is the unique key used to find and update the correct record in the inventory",
        "Build the `custom_data` JSON: add each enrichment column you want to push back:",
      ],
    },
    {
      type: "code",
      text: `{
  "qualification_status": {{qualification_status}},
  "ideal_segment": {{ideal_segment}},
  "lead_score": {{lead_score}}
}`,
    },
    {
      type: "p",
      text: "Add as many key-value pairs as you need. Each key becomes a filterable field in the inventory.",
    },
    {
      type: "ol",
      items: [
        "Test on 10 rows first: run a small batch to confirm the data is mapping correctly before running on the full list",
        "Once confirmed, run on all rows",
      ],
    },
    { type: "h", text: "After the Push" },
    {
      type: "ol",
      items: [
        "Go back to the inventory (refresh the page)",
        "In Companies or People, click Add Column",
        "Select the enrichment key you just pushed (e.g., `qualification_status`)",
        "It appears as a column and becomes filterable",
      ],
    },
    {
      type: "p",
      text: "You can now filter qualification_status = qualified to get your send-ready list without touching Clay again.",
    },
    { type: "h", text: "Important Notes" },
    {
      type: "ul",
      items: [
        "Domain is the identifier for companies. Make sure the domain column in Clay matches the domain stored in the inventory exactly",
        "LinkedIn URL is the identifier for people. Map it in the Post to Supabase node when pushing people-level enrichment",
        "Remove empty values from the JSON before pushing. Clay has a \"remove empty values\" toggle in the node; keep it off so you can push partial updates without overwriting filled fields",
        "Run on all rows (not just new) so that any records enriched in a previous run also get updated",
      ],
    },
  ],
  "emailbison-campaign-operations": [
    {
      type: "p",
      text: "There are two separate actions for EmailBison: adding leads to the workspace, and adding those leads to a campaign. Both are done from the inventory interface.",
    },
    { type: "h", text: "Step 1: Add Leads to EmailBison Workspace" },
    {
      type: "ol",
      items: [
        {
          text: "On the Companies or People page, apply your filters:",
          sub: [
            "Email: not empty",
            "Email status: ok (after verification)",
            "Any niche, client, or other filters you need",
          ],
        },
        "Click Add to Bison → select the client workspace from the dropdown",
        {
          text: "Map the columns: the interface auto-maps standard fields. Review and adjust:",
          sub: [
            "Map any custom enrichment fields you want to pass as variables",
            "To create a new custom variable that doesn't exist yet in EmailBison, type a new name → it will be created automatically in the workspace",
          ],
        },
        "Click Push",
        "The push runs as a background job in Push Activity; you don't need to wait on this screen",
      ],
    },
    { type: "h", text: "Check the Push Result" },
    { type: "p", text: "Go to Push Activity to see:" },
    {
      type: "ul",
      items: [
        "Total selected / Created (new) / Updated (already existed) / Failed",
        "Click View Contacts to see exactly which people were pushed, with the inventory filter pre-applied",
      ],
    },
    { type: "h", text: "Step 2: Add Leads to a Campaign" },
    { type: "p", text: "After the leads are in the workspace, add them to a campaign." },
    {
      type: "ol",
      items: [
        "Apply the same filters as Step 1 (same set of leads)",
        "Click Add to EmailBison Campaign → select the client workspace",
        {
          text: "Select an existing campaign from the dropdown, OR click Create New Campaign:",
          sub: [
            "Enter campaign name",
            "Add email sequences and copy",
            "Select sender emails from the dropdown (filter by tag: ESP, provider, category, batch)",
            "Add split variants if needed",
            "Configure sending schedule and daily limits",
          ],
        },
        "Map lead fields to campaign variables: any custom variables you created in Step 1 are available here",
        "Choose Add Leads and Launch or Add Leads and Save as Draft",
        "Push runs in the background → visible in Push Activity",
      ],
    },
    { type: "h", text: "Manual Settings in EmailBison (Still Required)" },
    {
      type: "p",
      text: "A few campaign settings cannot be configured from the inventory interface yet and must be set in EmailBison directly:",
    },
    {
      type: "ul",
      items: [
        "Remove \"include auto-replacement stats\"",
        "Enable plain text emails",
        "Set prioritize: new leads / follow-ups",
      ],
    },
    {
      type: "p",
      text: "These will be added to the interface in a future update. For now, open EmailBison → go to the campaign settings → confirm these are set before launching.",
    },
    { type: "h", text: "Tips" },
    {
      type: "ul",
      items: [
        "EmailBison push is fast: 2,000+ leads import in about 2 minutes",
        "If a lead's email already exists in the workspace, it returns a soft success (not an error); the lead simply isn't duplicated",
        "If you're setting up a Google-only campaign, filter by `mx_provider = google` before pushing. Same for Outlook. This ensures each campaign only receives leads that match that ESP",
      ],
    },
  ],
  "how-to-push-contacts-to-ghl": [
    {
      type: "p",
      text: "Push people directly from the inventory into GHL as contacts, with structured tags applied automatically.",
    },
    { type: "h", text: "Steps" },
    {
      type: "ol",
      items: [
        "Go to the People page",
        {
          text: "Apply your filters:",
          sub: [
            "Phone: not empty",
            "Niche: select the niche you're targeting",
            "Push status: Not yet pushed to GHL for [client]; this ensures you don't re-import leads already in that client's GHL sub-account",
          ],
        },
        "Click Push to GHL → select the client from the dropdown",
        {
          text: "Review the field mapping: the interface auto-maps standard fields:",
          sub: [
            "First name, last name, email, phone, company name, city, country",
            "Map Clean Company Name to the company name field (not the raw one)",
            "Map any GHL custom fields to the enrichment columns you want to pass",
          ],
        },
        "Add your tag: type the tag name for this import (e.g., `Kynship - Skincare | 1-10 | United States | aiark`). The base format is pre-filled; you can add extra identifiers like a segment name or batch label",
        "Click Push: runs as a background job in Push Activity",
      ],
    },
    { type: "h", text: "Push Activity" },
    { type: "p", text: "Go to Push Activity to check status:" },
    {
      type: "ul",
      items: [
        "Total selected / Created (new contacts) / Updated (tag appended to existing) / Failed",
        "Click View Contacts to see the exact people that were pushed, with filters pre-applied",
      ],
    },
    { type: "h", text: "How Duplicates Are Handled" },
    {
      type: "p",
      text: "GHL does not allow duplicate phone numbers. If a contact already exists:",
    },
    {
      type: "ul",
      items: [
        "GHL returns the existing contact's ID",
        "The interface appends the new tag to that contact; it does not create a duplicate",
        "This is counted as \"Updated\" in the push summary",
      ],
    },
    { type: "h", text: "Phone Type Filtering (Automatic)" },
    {
      type: "p",
      text: "Only mobile and toll_free phone numbers are pushed to GHL. Landlines are automatically skipped: even if they're in your filtered set, they will not be imported. This is a built-in safeguard.",
    },
    { type: "h", text: "After the Push" },
    {
      type: "p",
      text: "Open GHL → Contacts → filter by the tag you just applied → confirm the leads are there with all fields and tag correct.",
    },
    { type: "h", text: "Current Limitation" },
    {
      type: "p",
      text: "GHL's API does not allow creating workflows, bulk actions, or SMS sequences programmatically. After importing the contacts, go to GHL to:",
    },
    {
      type: "ul",
      items: [
        "Assign contacts to an existing workflow",
        "Set up bulk actions if needed",
      ],
    },
    {
      type: "p",
      text: "This is a GHL API constraint, not an interface limitation. It is planned to be addressed in a future update.",
    },
    { type: "h", text: "Performance Note" },
    {
      type: "p",
      text: "GHL's API rate limits mean pushes process at roughly 1,000 contacts every 4 minutes. This is not something we can speed up; it is a GHL constraint. For large imports, the push runs fully in the background so you can continue other work while it processes.",
    },
  ],
  "how-to-add-a-new-client": [
    {
      type: "p",
      text: "All client credentials are stored in the Clients section of the interface. Whenever you onboard a new client, add them here so they appear in the push dropdowns for GHL and EmailBison.",
    },
    { type: "h", text: "Steps" },
    {
      type: "ol",
      items: [
        "Go to Clients in the left nav",
        "Click Add New Client",
        "Fill in the following fields:",
      ],
    },
    {
      type: "table",
      head: ["Field", "What to enter"],
      rows: [
        ["Client Name", "Display name (e.g., `Kynship`)"],
        ["GHL API Key", "The client's PIT token from GHL (format: `pit-...`)"],
        ["GHL Location ID", "The sub-account ID from GHL"],
        ["EmailBison API Key", "The client's workspace key (format: `ID|TOKEN`)"],
        ["EmailBison Workspace ID", "The workspace ID from EmailBison"],
        ["Status", "Set to Active"],
      ],
    },
    { type: "ol", items: ["Click Save"] },
    {
      type: "p",
      text: "The client immediately appears in the GHL and EmailBison push dropdowns across the interface.",
    },
    { type: "h", text: "Updating Existing Client Credentials" },
    { type: "p", text: "If an API key is rotated or a new sub-account is set up:" },
    {
      type: "ol",
      items: [
        "Find the client in the Clients list",
        "Click into the field you need to update",
        "Edit inline → click Save",
      ],
    },
    { type: "p", text: "No code changes or redeployments needed." },
    { type: "h", text: "Notes" },
    {
      type: "ul",
      items: [
        "All 12 existing clients are already set up",
        "Only Admins and Developers can add or edit clients",
        "If a client is set to Inactive, they will not appear in any push dropdowns until reactivated",
      ],
    },
  ],
  "how-to-invite-a-team-member": [
    { type: "h", text: "Steps" },
    {
      type: "ol",
      items: [
        "Go to Team in the left nav",
        "Enter the person's email address in the invite field",
        "Click Send Invite",
        {
          text: "Select their role:",
          sub: [
            "Member: standard access, can import, filter, push, and export",
            "Admin: can manage team members and client credentials",
            "Developer: full access including settings and technical configuration",
          ],
        },
        "The person receives an invite email → they click the link → set a password → they're in",
      ],
    },
    { type: "h", text: "Notes" },
    {
      type: "ul",
      items: [
        "Roles can be changed after the fact: find the member in the Team list and update their role",
        "To remove a member, find them in the Team list and click Remove",
        "All actions taken by each member are logged in the Activity section with their email and timestamp",
      ],
    },
  ],
};

export const SECTIONS: HelpSection[] = SECTION_META.map((meta) => ({
  ...meta,
  blocks: BLOCKS[meta.id] ?? [],
}));
