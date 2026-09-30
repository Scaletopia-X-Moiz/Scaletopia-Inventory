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
 * Relative time the way the GHL Contacts list renders it — used only for the
 * "Last activity" column, which is a mirror of a number the user can also read
 * in GHL's own UI, so any drift reads as a bug in our table.
 *
 * Two deliberate differences from `timeAgo` above, both verified against the
 * live GHL UI (docs/features/ghl-last-activity/handoff.md §13.1):
 *
 *  1. It TRUNCATES, it does not round. 1.97 years renders "1 year ago", not
 *     "2 years ago"; 16 days renders "2 weeks ago" (floor(16/7)). Rounding
 *     puts most rows off by one, which was the entire apparent mismatch that
 *     made the research look wrong before it was understood.
 *  2. It has a weeks tier, which `timeAgo` doesn't.
 *
 * `timeAgo` is left exactly as-is rather than parameterized: it is what every
 * other timestamp in the app already renders, and changing its rounding would
 * silently shift them all.
 *
 * Each tier is entered by the largest unit that fits, so there is no gap
 * between "12 months" and "1 year" (364 days is 11 months, 365 is 1 year).
 * Empty string for null/unparseable, which every call site renders as blank —
 * a person with no qualifying message has no last activity, and GHL shows
 * that cell blank too.
 */
export function ghlTimeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const sec = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;

  if (day >= 365) return plural(Math.floor(day / 365), "year");
  if (day >= 30) return plural(Math.floor(day / 30), "month");
  if (day >= 7) return plural(Math.floor(day / 7), "week");
  if (day >= 1) return plural(day, "day");
  if (hr >= 1) return plural(hr, "hour");
  if (min >= 1) return plural(min, "minute");
  return "Just now";
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
