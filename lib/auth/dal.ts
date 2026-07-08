import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface SessionUser {
  id: string;
  email: string;
  role: "admin" | "member";
}

/**
 * Returns the signed-in user (with role from `profiles`) or null. Memoized per
 * request so multiple callers in one render don't re-hit Supabase.
 */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  return {
    id: user.id,
    email: user.email ?? "",
    role: (profile?.role as "admin" | "member") ?? "member",
  };
});

/** Redirects to /login if not signed in; otherwise returns the user. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/** Redirects to /login if not signed in, or to / if signed in but not admin. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user;
}
