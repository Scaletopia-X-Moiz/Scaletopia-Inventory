import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type Role = "admin" | "member" | "dev";

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
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
    role: (profile?.role as Role) ?? "member",
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

/**
 * Redirects to /login if not signed in, or to / if signed in but neither
 * admin nor dev. `dev` is effectively admin plus the right to change ticket
 * status (see canChangeTicketStatus), so it shares admin's access to the
 * existing admin panel (/team, /activity).
 */
export async function requireAdminOrDev(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin" && user.role !== "dev") redirect("/");
  return user;
}

/** admin and dev can create/edit ticket content, manage notes, and delete
 * tickets; member can only create tickets and view their own. */
export function canManageTickets(role: Role): boolean {
  return role === "admin" || role === "dev";
}

/** Only dev can move a ticket between open / in_progress / done — this is
 * the one right admin does not have, by design. */
export function canChangeTicketStatus(role: Role): boolean {
  return role === "dev";
}
