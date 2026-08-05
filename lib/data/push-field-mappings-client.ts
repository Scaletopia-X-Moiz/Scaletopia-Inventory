"use client";

/**
 * Client-side load/save for `/api/push-field-mappings` (ticket #114), shared
 * by the GHL and EmailBison push buttons (People and Companies). Each
 * caller's `mapping` is opaque here — its shape is whatever that platform's
 * push button sends/expects back.
 */

export async function fetchSavedPushFieldMapping<T>(
  clientId: string,
  platform: string
): Promise<T | null> {
  const res = await fetch(
    `/api/push-field-mappings?clientId=${encodeURIComponent(clientId)}&platform=${encodeURIComponent(platform)}`
  );
  if (!res.ok) throw new Error("Failed to load saved field mapping");
  const data = (await res.json()) as { mapping: T } | null;
  return data?.mapping ?? null;
}

export async function savePushFieldMapping(
  clientId: string,
  platform: string,
  mapping: unknown
): Promise<void> {
  await fetch("/api/push-field-mappings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, platform, mapping }),
  });
}
