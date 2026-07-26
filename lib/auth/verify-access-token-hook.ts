/**
 * Manual verification for Slice 3 (issue #29): signs in a real user and
 * decodes the resulting access token to confirm (a) the Custom Access Token
 * Hook is wired up and injecting `user_role`, and (b) the token's header alg
 * is ES256 — the assumption Slice 2's local `getClaims()` verification
 * depends on.
 *
 * This does NOT verify the token's signature; it only decodes the header and
 * payload, which is all that's needed to confirm shape and claims.
 *
 * Run: SCALETOPIA_TEST_EMAIL=you@example.com SCALETOPIA_TEST_PASSWORD=... \
 *   npm run verify:auth-hook
 *
 * Deliberately does not import lib/supabase/*: those modules pull in
 * "server-only", which throws outside a Next.js server bundle. This script
 * builds its own client instead, matching lib/import/backfill-canonical-columns.ts.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.SCALETOPIA_TEST_EMAIL;
const password = process.env.SCALETOPIA_TEST_PASSWORD;

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set",
  );
}
if (!email || !password) {
  throw new Error(
    "SCALETOPIA_TEST_EMAIL and SCALETOPIA_TEST_PASSWORD must be set to a real profiles user",
  );
}

function decodeJwtPart(part: string): unknown {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(base64, "base64").toString("utf8");
  return JSON.parse(json);
}

async function main() {
  const supabase = createClient(url!, anonKey!, { auth: { persistSession: false } });
  const supabaseAdmin = createClient(url!, serviceRoleKey!, { auth: { persistSession: false } });

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email!,
    password: password!,
  });
  if (error || !data.session) {
    throw new Error(`Sign-in failed: ${error?.message ?? "no session returned"}`);
  }

  const token = data.session.access_token;
  const parts = token.split(".");
  const header = decodeJwtPart(parts[0]) as { alg?: string };
  const payloadPart = parts[1];
  const payload = decodeJwtPart(payloadPart) as Record<string, unknown>;

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  console.log("Header:", header);
  console.log("Payload:", payload);
  console.log();
  console.log(`alg is ES256: ${header.alg === "ES256" ? "YES" : `NO (got ${header.alg})`}`);

  const claimRole = payload.user_role;
  const profileRole = profile?.role ?? null;
  console.log(
    `user_role claim matches profiles.role: ${
      "user_role" in payload && claimRole === profileRole
        ? `YES (${claimRole})`
        : `NO (claim=${claimRole ?? "<absent>"}, profiles.role=${profileRole ?? "<none>"})`
    }`,
  );

  await supabase.auth.signOut();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
