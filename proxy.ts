import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Paths reachable without a session: the login page, the invite/reset
// acceptance routes, the cache-warming ping the login screen fires so
// authenticated pages load without a cold full-table scan (see api/warm), and
// the internal worker endpoints, which carry no session cookie (Vercel Cron /
// self-chain) and enforce their own auth (see api/internal/*/route.ts).
function isPublicPath(path: string) {
  return (
    path === "/login" ||
    path === "/api/warm" ||
    path.startsWith("/auth") ||
    path.startsWith("/api/internal")
  );
}

/**
 * Runs before every non-static request. Refreshes the Supabase session cookie
 * and redirects unauthenticated users to /login (or returns 401 for API
 * routes). This is an optimistic gate — server components and route handlers
 * still verify the session at the data source via the DAL.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: claimsData,
  } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;

  const path = request.nextUrl.pathname;

  if (!claims && !isPublicPath(path)) {
    if (path.startsWith("/api")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Already signed in — keep users off the login page.
  if (claims && path === "/login") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  // Run on everything except Next internals and static asset files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.png$).*)"],
};
