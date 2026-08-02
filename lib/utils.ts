import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const KNOWN_ACRONYMS: Record<string, string> = {
  dtc: "DTC",
  saas: "SaaS",
  crm: "CRM",
  b2b: "B2B",
  b2c: "B2C",
  ai: "AI",
  us: "US",
  uk: "UK",
  eu: "EU",
};

export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (sec < 60) return "Just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const yr = Math.round(mo / 12);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

/**
 * Absolute date+time string, e.g. for a `title` tooltip on a relative
 * ("3 hours ago") timestamp. Locale is pinned explicitly (matching the
 * "en-US" convention used for numbers elsewhere in this app) so server and
 * client render byte-identical output — `toLocaleString(undefined, ...)`
 * falls back to the runtime's default locale, which differs between Node's
 * server locale and the browser's locale and causes a hydration mismatch.
 */
export function formatAbsoluteDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => {
      const known = KNOWN_ACRONYMS[word.toLowerCase()];
      return known ?? word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}
