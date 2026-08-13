// Clean up orphaned __test-emailbison-push__ rows left in the LIVE DB by an
// interrupted `vitest run` (push-to-emailbison.test.ts seeds real rows and only
// removes them in afterAll). Mirrors that file's own cleanupAll teardown, plus
// the auth test users it creates. Reports counts before/after; deletes ONLY the
// TEST_PREFIX-tagged rows.
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TEST_PREFIX = "__test-emailbison-push__";

async function count() {
  const [{ data: clients }, { data: people }, { data: companies }] = await Promise.all([
    admin.from("clients").select("id,slug").like("slug", `${TEST_PREFIX}%`),
    admin.from("people").select("id").like("linkedin_url", `%${TEST_PREFIX}%`),
    admin.from("companies").select("id").like("domain", `${TEST_PREFIX}%`),
  ]);
  return { clients: clients ?? [], people: people ?? [], companies: companies ?? [] };
}

const before = await count();
console.log(`BEFORE: clients=${before.clients.length} people=${before.people.length} companies=${before.companies.length}`);
console.log(`  client slugs: ${JSON.stringify(before.clients.map((c) => c.slug))}`);

// Delete in FK-safe order: platform_pushes (plain FKs) first, then people,
// then clients, then companies (people's FK parent).
const personIds = before.people.map((p) => p.id);
const clientIds = before.clients.map((c) => c.id);
if (personIds.length) {
  const { error } = await admin.from("platform_pushes").delete().in("person_id", personIds);
  if (error) console.log(`platform_pushes by person: ${error.message}`);
}
if (clientIds.length) {
  const { error } = await admin.from("platform_pushes").delete().in("client_id", clientIds);
  if (error) console.log(`platform_pushes by client: ${error.message}`);
}
for (const [table, col, pat] of [
  ["people", "linkedin_url", `%${TEST_PREFIX}%`],
  ["clients", "slug", `${TEST_PREFIX}%`],
  ["companies", "domain", `${TEST_PREFIX}%`],
]) {
  const { error } = await admin.from(table).delete().like(col, pat);
  console.log(`delete ${table}: ${error ? "ERROR " + error.message : "ok"}`);
}

// Auth test users: email `__test-emailbison-push__...@example.com`
let removedUsers = 0;
for (let page = 1; page <= 20; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.log(`listUsers: ${error.message}`); break; }
  const users = data?.users ?? [];
  const testUsers = users.filter((u) => (u.email ?? "").includes(TEST_PREFIX));
  for (const u of testUsers) {
    const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
    if (delErr) console.log(`deleteUser ${u.email}: ${delErr.message}`);
    else removedUsers++;
  }
  if (users.length < 200) break;
}
console.log(`removed auth test users: ${removedUsers}`);

const after = await count();
console.log(`AFTER:  clients=${after.clients.length} people=${after.people.length} companies=${after.companies.length}`);
console.log(after.clients.length + after.people.length + after.companies.length === 0 ? "✅ all test data removed" : "⚠️ some rows remain");
