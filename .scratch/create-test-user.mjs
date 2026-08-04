import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const email = "claude-qa-test@scaletopia.local";
const password = "ClaudeQaTest!2026";

let userId;
const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});

if (createErr) {
  if (createErr.message.includes("already been registered") || createErr.status === 422) {
    const { data: list } = await admin.auth.admin.listUsers();
    const existing = list.users.find((u) => u.email === email);
    if (!existing) throw createErr;
    userId = existing.id;
    await admin.auth.admin.updateUserById(userId, { password });
    console.log("Reused existing test user:", userId);
  } else {
    throw createErr;
  }
} else {
  userId = created.user.id;
  console.log("Created test user:", userId);
}

// Ensure a profiles row exists with admin role (trigger may or may not have fired)
const { data: profile } = await admin.from("profiles").select("id, role").eq("id", userId).maybeSingle();
console.log("Existing profile:", profile);

if (!profile) {
  const { error: insErr } = await admin.from("profiles").insert({ id: userId, role: "admin" });
  if (insErr) console.error("Insert profile error:", insErr);
  else console.log("Inserted profile with role=admin");
} else if (profile.role !== "admin") {
  const { error: updErr } = await admin.from("profiles").update({ role: "admin" }).eq("id", userId);
  if (updErr) console.error("Update profile error:", updErr);
  else console.log("Updated profile role to admin");
}

console.log("\nTest login credentials:");
console.log("email:", email);
console.log("password:", password);
