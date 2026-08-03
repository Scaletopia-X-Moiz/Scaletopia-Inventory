"use client";

/**
 * Client-side fetch for `/api/clients/active`, the client-picker data source
 * shared by the GHL and EmailBison push buttons (People and Companies).
 *
 * Ticket #90: QA saw a rare, self-resolving "Failed to load clients" on the
 * picker's first open — once out of 10+ opens across 4 sessions, gone on
 * reload. This fetch fires from an explicit button click (well after the
 * page's session/cookies are already established), so a cold-navigation
 * auth race doesn't fit the code path here; the signature instead matches a
 * one-off transient network/Supabase blip. A single retry mirrors what a
 * manual reload already fixed, without masking a real, repeated failure —
 * that still surfaces the error to the user after the retry also fails.
 */
export async function fetchActiveClients<T>(): Promise<T> {
  async function attempt(): Promise<T> {
    const res = await fetch("/api/clients/active");
    if (!res.ok) throw new Error("Failed to load clients");
    return (await res.json()) as T;
  }

  try {
    return await attempt();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return attempt();
  }
}
