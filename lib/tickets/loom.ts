/** Returns a clean https Loom share URL, or null if `raw` isn't one. */
export function normalizeLoomUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "loom.com" && host !== "www.loom.com") return null;
  if (!/^\/(share|embed)\/[a-zA-Z0-9]+/.test(url.pathname)) return null;
  return url.toString();
}
