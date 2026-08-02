/**
 * One-off data-quality audit for issue #78 — "Audit niche-tagging accuracy
 * across the catalog". Not part of the automated test suite — run by hand
 * against the live DB:
 *
 *   npm run audit:niche-tagging
 *
 * Methodology (see docs/reports/niche-tagging-audit.md for the full writeup):
 *
 * 1. The `companies.niche` column turns out to hold two unrelated
 *    vocabularies. "Real" niches are the kebab-case client-targeting slugs
 *    (`dtc-beauty`, `saas-crm`, `dtc-fashion-apparel`, `sports-outdoor`,
 *    `marketing-agencies`). Everything else observed is a Title-Case IAB-style
 *    content category (`Business And Industrial`, `Food And Drink`, ...) that
 *    leaked into the niche column from some other classification step. We
 *    split on `/^[a-z0-9]+(-[a-z0-9]+)*$/` to separate the two groups
 *    automatically rather than hardcoding the slug list, so a newly-added
 *    real niche is picked up without editing this script.
 * 2. For the "real" niches, we cross-reference `industry_id` (and, if empty,
 *    `description`) against a small hand-built keyword map of trade/skilled-
 *    labor terms (construction, HVAC, plumbing, roofing, electrical,
 *    landscaping, ...) that cannot plausibly co-occur with any of the
 *    DTC/SaaS/agency niches currently in use. This mirrors the exact failure
 *    mode QA found (HVAC companies tagged `dtc-beauty` / `saas-crm`) and
 *    avoids overfitting a bespoke "expected industry" list per niche, which
 *    would need constant upkeep as niches are added.
 * 3. For "category-leak" niches we don't attempt a mismatch heuristic (the
 *    value isn't a targeting niche to begin with) — we just report how many
 *    rows fall into this bucket, since it's a distinct, larger-scope finding
 *    than row-level mismatches within a real niche.
 *
 * Deliberately does not import lib/supabase/admin.ts (pulls in "server-only"),
 * matching the pattern in scripts/bench-dashboard.ts.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}
const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const PAGE_SIZE = 1000;
const REAL_NICHE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Trade/skilled-labor keywords that cannot plausibly co-occur with any
// DTC/SaaS/agency niche currently in the catalog. Matched against
// industry_id first, falling back to description when industry is empty.
const TRADE_KEYWORDS = [
  "construction",
  "hvac",
  "heating",
  "cooling",
  "air condition",
  "plumbing",
  "roofing",
  "electrical contractor",
  "general contractor",
  "remodeling",
  "landscaping",
  "land improvement",
  "home improvement",
  "civil engineering",
  "building materials",
];
const TRADE_RE = new RegExp(TRADE_KEYWORDS.map((k) => k.replace(/ /g, "\\s+")).join("|"), "i");

interface Row {
  id: number;
  company_name: string | null;
  niche: string | null;
  industry: string | null;
  industry_id: string | null;
  description: string | null;
}

async function fetchAllCompanies(): Promise<Row[]> {
  const { count, error: countError } = await supabase
    .from("companies")
    .select("id", { count: "exact", head: true });
  if (countError) throw countError;
  const total = count ?? 0;

  const pageCount = Math.ceil(total / PAGE_SIZE);
  const rows: Row[] = [];
  for (let i = 0; i < pageCount; i++) {
    const { data, error } = await supabase
      .from("companies")
      .select("id,company_name,niche,industry,industry_id,description")
      .order("id", { ascending: true })
      .range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
  }
  return rows;
}

function isTradeMismatch(row: Row): boolean {
  const haystack = row.industry_id?.trim() || row.description?.trim() || "";
  if (!haystack) return false;
  return TRADE_RE.test(haystack);
}

interface NicheStats {
  niche: string;
  kind: "real" | "category-leak" | "null";
  total: number;
  withIndustryOrDescription: number;
  mismatches: Row[];
}

async function main() {
  console.log("Fetching all companies (niche, industry, industry_id, description)...");
  const rows = await fetchAllCompanies();
  console.log(`Fetched ${rows.length} rows.\n`);

  const byNiche = new Map<string, NicheStats>();
  for (const row of rows) {
    const nicheKey = row.niche?.trim() || "(untagged)";
    const kind: NicheStats["kind"] =
      nicheKey === "(untagged)" ? "null" : REAL_NICHE_RE.test(nicheKey) ? "real" : "category-leak";
    let stats = byNiche.get(nicheKey);
    if (!stats) {
      stats = { niche: nicheKey, kind, total: 0, withIndustryOrDescription: 0, mismatches: [] };
      byNiche.set(nicheKey, stats);
    }
    stats.total++;
    if (row.industry?.trim() || row.description?.trim()) stats.withIndustryOrDescription++;
    if (kind === "real" && isTradeMismatch(row)) stats.mismatches.push(row);
  }

  const all = Array.from(byNiche.values()).sort((a, b) => b.total - a.total);
  const realNiches = all.filter((s) => s.kind === "real");
  const categoryLeakNiches = all.filter((s) => s.kind === "category-leak");
  const untagged = all.find((s) => s.kind === "null");

  const totalRows = rows.length;
  const totalTagged = totalRows - (untagged?.total ?? 0);
  const totalCategoryLeak = categoryLeakNiches.reduce((sum, s) => sum + s.total, 0);
  const totalReal = realNiches.reduce((sum, s) => sum + s.total, 0);
  const totalMismatches = realNiches.reduce((sum, s) => sum + s.mismatches.length, 0);

  console.log("=== Real niches (kebab-case client-targeting slugs) ===");
  for (const s of realNiches) {
    const pct = s.total > 0 ? ((s.mismatches.length / s.total) * 100).toFixed(2) : "0.00";
    console.log(
      `${s.niche}: total=${s.total}, withIndustry/Desc=${s.withIndustryOrDescription}, tradeMismatches=${s.mismatches.length} (${pct}%)`
    );
  }
  console.log("\n=== Category-leak niches (IAB-style, not real client niches) ===");
  for (const s of categoryLeakNiches) {
    console.log(`${s.niche}: total=${s.total}`);
  }
  console.log(`\nUntagged (niche IS NULL): ${untagged?.total ?? 0}`);
  console.log(
    `\nTotals: ${totalRows} companies | ${totalTagged} tagged | ${totalReal} under real niches | ${totalCategoryLeak} under category-leak niches | ${totalMismatches} trade-keyword mismatches within real niches`
  );

  // ---- Build markdown report ----
  const lines: string[] = [];
  lines.push("# Niche-tagging accuracy audit");
  lines.push("");
  lines.push(`Generated by \`scripts/audit-niche-tagging.ts\` — issue #78, ${new Date().toISOString().slice(0, 10)}.`);
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "The `companies.niche` column turns out to hold **two unrelated vocabularies**, discovered by dumping the full distinct-value distribution before writing any mismatch heuristic:"
  );
  lines.push("");
  lines.push(
    "1. **Real niches** — kebab-case client-targeting slugs (`dtc-beauty`, `saas-crm`, `dtc-fashion-apparel`, `sports-outdoor`, `marketing-agencies`). These are what `niche`-filtered lists for GHL/EmailBison pushes actually mean to use."
  );
  lines.push(
    "2. **Category-leak niches** — Title-Case, IAB-style content-category strings (`Business And Industrial`, `Technology And Computing`, `Food And Drink`, `Law  Govt And Politics`, ...). These read like a generic content-classification taxonomy, not anything a client asked to target, and are not niches at all — they look like a leftover/misrouted field from an import or enrichment step that wrote a category value into `niche` instead of leaving it blank or writing a real niche."
  );
  lines.push("");
  lines.push(
    "The two are told apart programmatically with `/^[a-z0-9]+(-[a-z0-9]+)*$/` (all-lowercase, hyphen-delimited = real niche; anything else present = category-leak), so a newly added real niche is picked up automatically without editing this script."
  );
  lines.push("");
  lines.push(
    "For the **real** niches, each row's `industry_id` (falling back to `description` when industry is empty) is checked against a keyword list of trade/skilled-labor terms — construction, HVAC, heating, cooling, plumbing, roofing, electrical contractor, general contractor, remodeling, landscaping, civil engineering, building materials — that cannot plausibly co-occur with any DTC/SaaS/agency niche currently in the catalog. This directly targets the failure mode QA found (HVAC/construction companies tagged `dtc-beauty` / `saas-crm`) without needing a bespoke \"expected industry\" allowlist per niche (which would need upkeep every time a niche is added, and would produce more false positives than a narrow, high-confidence red-flag list)."
  );
  lines.push("");
  lines.push(
    "For **category-leak** niches, a mismatch heuristic doesn't apply — the value was never a targeting niche — so this report just quantifies how many rows fall into that bucket."
  );
  lines.push("");
  lines.push("## Top-line numbers");
  lines.push("");
  lines.push(`- ${totalRows.toLocaleString()} companies total.`);
  lines.push(`- ${(untagged?.total ?? 0).toLocaleString()} untagged (\`niche IS NULL\`).`);
  lines.push(`- ${totalTagged.toLocaleString()} tagged, of which:`);
  lines.push(
    `  - ${totalReal.toLocaleString()} (${((totalReal / totalTagged) * 100).toFixed(1)}%) carry a real client niche.`
  );
  lines.push(
    `  - ${totalCategoryLeak.toLocaleString()} (${((totalCategoryLeak / totalTagged) * 100).toFixed(1)}%) carry a category-leak value instead of a real niche — larger in row count than the real-niche bucket.`
  );
  lines.push(
    `- Within real niches, ${totalMismatches.toLocaleString()} rows (${((totalMismatches / totalReal) * 100).toFixed(2)}% of real-niche rows) match a trade/skilled-labor keyword that cannot plausibly belong to that niche.`
  );
  lines.push("");
  lines.push("## Real niches — mismatch counts");
  lines.push("");
  lines.push("| Niche | Total rows | Rows with industry/description | Trade-keyword mismatches | Mismatch % |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const s of realNiches) {
    const pct = s.total > 0 ? ((s.mismatches.length / s.total) * 100).toFixed(2) : "0.00";
    lines.push(
      `| \`${s.niche}\` | ${s.total.toLocaleString()} | ${s.withIndustryOrDescription.toLocaleString()} | ${s.mismatches.length.toLocaleString()} | ${pct}% |`
    );
  }
  lines.push("");
  lines.push(
    "`dtc-fashion-apparel`, `sports-outdoor`, and `marketing-agencies` have **0%** industry/description fill — every row in those niches is opaque to this (or any industry-based) heuristic. Their mismatch count of 0 above means \"none detected,\" not \"none exist\" — see Scope & severity assessment."
  );
  lines.push("");
  lines.push("## Sample mismatched rows");
  lines.push("");
  for (const s of realNiches) {
    if (s.mismatches.length === 0) continue;
    lines.push(`### \`${s.niche}\` (${s.mismatches.length} mismatches)`);
    lines.push("");
    lines.push("| Company | Current niche | Industry | Description (truncated) | Suspected correct niche |");
    lines.push("|---|---|---|---|---|");
    for (const row of s.mismatches.slice(0, 8)) {
      const desc = (row.description ?? "").replace(/\|/g, "/").slice(0, 120);
      lines.push(
        `| ${row.company_name ?? "(no name)"} | \`${row.niche}\` | ${row.industry_id ?? "(none)"} | ${desc} | none of the current niches — needs a construction/home-services niche or should be excluded |`
      );
    }
    lines.push("");
  }
  lines.push("## Category-leak niches — row counts");
  lines.push("");
  lines.push("| Value in `niche` | Rows |");
  lines.push("|---|---:|");
  for (const s of categoryLeakNiches) {
    lines.push(`| ${s.niche} | ${s.total.toLocaleString()} |`);
  }
  lines.push("");
  lines.push("## Scope & severity assessment");
  lines.push("");
  lines.push(
    "**Two distinct issues, different severities:**"
  );
  lines.push("");
  lines.push(
    `1. **Category leakage (larger in scope, lower urgency today).** ${totalCategoryLeak.toLocaleString()} rows (${((totalCategoryLeak / totalTagged) * 100).toFixed(1)}% of tagged rows) carry an IAB-style content category instead of a real client niche. These rows are never returned by a real \`niche=\` filter (e.g. \`niche=dtc-beauty\`) today because they don't match any real niche slug — which is exactly why the QA spot-check on \`Food And Drink\` "looked clean": that value isn't used as a push-targeting niche in the first place, so no client is currently being sent this list under a niche filter. The risk is latent, not active: if a client ever gets tagged with one of these category values as their "niche" (or the UI starts treating these values as selectable niches), the same silent-mistargeting risk applies at ~2x the row count of the real-niche mismatch problem. Recommend documenting as a known data-quality debt and tracking down the import/enrichment step that writes these values, rather than an urgent fix, since it isn't causing incorrect pushes today.`
  );
  lines.push(
    `2. **Trade-keyword mismatches within real niches (smaller in row count, directly actionable, and the one QA actually caught in the wild).** ${totalMismatches.toLocaleString()} of ${totalReal.toLocaleString()} real-niche rows (${((totalMismatches / totalReal) * 100).toFixed(2)}%) are HVAC/construction/trade companies mistagged under a DTC/SaaS niche. Concentrated almost entirely in \`dtc-beauty\`; \`saas-crm\` has a handful. This is a low overall percentage but a nonzero, real risk to push accuracy for those two niches specifically.`
  );
  lines.push("");
  lines.push(
    `\`dtc-fashion-apparel\`, \`sports-outdoor\`, and \`marketing-agencies\` cannot be audited this way at all — 0% of rows in each have any \`industry\` or \`description\` populated, so this heuristic can neither confirm nor rule out mistagging for ~${realNiches.filter((s) => s.withIndustryOrDescription === 0).reduce((sum, s) => sum + s.total, 0).toLocaleString()} rows. That's a separate, prerequisite data-quality gap (missing enrichment data) rather than a tagging-accuracy finding.`
  );
  lines.push("");
  lines.push("## Follow-up");
  lines.push("");
  lines.push(
    "Filed as separate GitHub issues (see links added after this report was generated) rather than bundled into this audit, so each can be triaged/remediated independently:"
  );
  lines.push("");
  lines.push("- Trade/HVAC companies mistagged under `dtc-beauty` and `saas-crm`.");
  lines.push(
    "- Category-leak values (`Business And Industrial`, `Food And Drink`, etc.) occupying the `niche` column instead of a real niche or null."
  );
  lines.push(
    "- Zero industry/description fill for `dtc-fashion-apparel`, `sports-outdoor`, `marketing-agencies` blocks any tagging-accuracy audit of those niches."
  );
  lines.push("");

  const reportPath = "docs/reports/niche-tagging-audit.md";
  writeFileSync(reportPath, lines.join("\n"));
  console.log(`\nWrote report to ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
