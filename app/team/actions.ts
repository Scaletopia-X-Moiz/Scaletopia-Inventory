"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/dal";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { logActivity } from "@/lib/activity/log";

export interface InviteState {
  error?: string;
  success?: string;
}

async function siteOrigin(): Promise<string> {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function inviteUser(
  _prev: InviteState | undefined,
  formData: FormData
): Promise<InviteState> {
  const admin = await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }

  const origin = await siteOrigin();
  const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/auth/set-password`,
  });

  if (error) {
    return { error: error.message };
  }

  await logActivity("user.invite", { email }, admin);
  revalidatePath("/team");
  return { success: `Invite sent to ${email}.` };
}

export async function setRole(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");
  const email = String(formData.get("email") ?? "");

  if (!userId || (role !== "admin" && role !== "member")) return;

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ role })
    .eq("id", userId);

  if (!error) {
    await logActivity("user.role_change", { email, role }, admin);
    revalidatePath("/team");
  }
}

export async function removeUser(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const email = String(formData.get("email") ?? "");

  // Guard against self-removal, which would lock the admin out mid-session.
  if (!userId || userId === admin.id) return;

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (!error) {
    await logActivity("user.remove", { email }, admin);
    revalidatePath("/team");
  }
}
