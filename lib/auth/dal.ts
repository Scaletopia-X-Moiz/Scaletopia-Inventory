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

const VALID_ROLES: readonly Role[] = ["admin", "member", "dev"];

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (VALID_ROLES as readonly string[]).includes(value);
}

/**
 * Returns the signed-in user or null. Memoized per request so multiple
 * callers in one render don't re-hit Supabase.
 *
 * Role is read from the `user_role` claim injected into the JWT by the
 * Custom Access Token Hook (see verify-access-token-hook.ts), so no DB call
 * is needed on the common path. The `profiles` table lookup is kept only as
 * a fallback for older tokens minted before the hook was wired up.
 */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: claimsData,
  } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;

  if (!claims) return null;

  if (isRole(claims.user_role)) {
    return {
      id: claims.sub,
      email: claims.email ?? "",
      role: claims.user_role,
    };
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", claims.sub)
    .maybeSingle();

  return {
    id: claims.sub,
    email: claims.email ?? "",
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
