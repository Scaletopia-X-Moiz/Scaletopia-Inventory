"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/dal";
import { logActivity } from "@/lib/activity/log";

export async function logout() {
  const user = await getUser();
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  if (user) {
    await logActivity("auth.logout", {}, user);
  }
  redirect("/login");
}

/**
 * Called from the set-password page right after `supabase.auth.updateUser`
 * succeeds client-side. The invite/reset link already established a session
 * (cookies are set via the browser client), so `getUser()` here resolves the
 * user who just accepted the invite.
 */
export async function confirmInviteAccepted(): Promise<void> {
  const user = await getUser();
  if (!user) return;
  await logActivity("user.invite_accepted", { email: user.email }, user);
}
