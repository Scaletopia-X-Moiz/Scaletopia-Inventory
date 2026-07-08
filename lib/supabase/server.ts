import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set"
  );
}

/**
 * Cookie-backed Supabase client for use in Server Components, Server Actions,
 * and Route Handlers. It reads/writes the auth session cookie so `getUser()`
 * reflects the signed-in user. Uses the public anon key (never the service
 * role key) because it acts on behalf of the end user.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(url!, anonKey!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` was called from a Server Component, where cookies are
          // read-only. Safe to ignore — the proxy refreshes the session cookie.
        }
      },
    },
  });
}
