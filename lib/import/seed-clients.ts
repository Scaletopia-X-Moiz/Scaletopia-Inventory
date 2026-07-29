/**
 * One-time seed: populates the `clients` table (lib/data/clients.sql, which
 * must be run first) from the existing GHL_<SLUG>_API_KEY /
 * GHL_<SLUG>_LOCATION_ID pairs in .env.local. `<SLUG>` becomes the client's
 * slug (lowercased) and display name (title-cased, underscores to spaces) —
 * update the row by hand afterwards if a client needs a nicer name.
 *
 * Run once via `npm run seed:clients`. Safe to re-run — upserts on `slug`,
 * so it only overwrites the ghl_* columns for clients whose env vars are
 * still present and otherwise leaves existing rows alone.
 *
 * Deliberately does not import lib/supabase/admin.ts: that module pulls in
 * the "server-only" marker package, which throws unconditionally outside a
 * Next.js server bundle. This script builds its own client instead.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}
const supabaseAdmin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

// Overrides for slugs where a plain title-case of the env var loses real
// detail (e.g. the "(A2P verified)" suffix GHL shows for this sub-account).
const NAME_OVERRIDES: Record<string, string> = {
  SCALETOPIA: "Scaletopia (A2P verified)",
};

function titleCase(slug: string): string {
  return slug
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function envOrNull(key: string): string | null {
  const value = process.env[key];
  return value && value.trim() !== "" ? value : null;
}

function discoverSlugs(): string[] {
  const slugs = new Set<string>();
  const pattern = /^GHL_(.+?)_(API_KEY|LOCATION_ID)$/;
  for (const key of Object.keys(process.env)) {
    const match = pattern.exec(key);
    if (match) slugs.add(match[1]);
  }
  return [...slugs].sort();
}

async function main() {
  const slugs = discoverSlugs();
  if (slugs.length === 0) {
    console.log("No GHL_<CLIENT>_API_KEY / GHL_<CLIENT>_LOCATION_ID vars found in .env.local — nothing to seed.");
    return;
  }

  console.log(`Seeding ${slugs.length} client(s) from .env.local: ${slugs.join(", ")}`);

  const rows = slugs.map((rawSlug) => ({
    slug: rawSlug.toLowerCase(),
    name: NAME_OVERRIDES[rawSlug] ?? titleCase(rawSlug),
    ghl_api_key: envOrNull(`GHL_${rawSlug}_API_KEY`),
    ghl_location_id: envOrNull(`GHL_${rawSlug}_LOCATION_ID`),
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabaseAdmin.from("clients").upsert(rows, { onConflict: "slug" });
  if (error) throw error;

  console.log(`Done. Upserted: ${slugs.map((s) => s.toLowerCase()).join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
