import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getUser, type SessionUser } from "@/lib/auth/dal";

/**
 * Appends one row to the activity log. Resolves the acting user from the
 * request session unless an explicit `actor` is passed. Never throws — logging
 * must never break the action it records; failures are console-warned instead.
 *
 * @param action  short machine key, e.g. "import.run", "clay.push", "user.invite"
 * @param details arbitrary structured context shown in the activity feed
 * @param actor   override when the session isn't available at the call site
 */
export async function logActivity(
  action: string,
  details: Record<string, unknown> = {},
  actor?: Pick<SessionUser, "id" | "email">
): Promise<void> {
  try {
    const user = actor ?? (await getUser());
    const { error } = await supabaseAdmin.from("activity_log").insert({
      user_id: user?.id ?? null,
      user_email: user?.email ?? null,
      action,
      details,
    });
    if (error) {
      console.warn(`[activity] failed to log "${action}": ${error.message}`);
    }
  } catch (err) {
    console.warn(`[activity] failed to log "${action}":`, err);
  }
}
