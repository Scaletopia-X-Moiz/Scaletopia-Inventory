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
