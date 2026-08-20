import { SECTION_META, type HelpSectionMeta } from "./help-sections";

/**
 * Which help sections (SOP + Loom) belong to which page.
 *
 * The first entry is the primary one: its Loom plays inside the topbar help
 * popover and "View more" deep-links to `/help#<id>`. The rest are offered as
 * "Related guides" links.
 *
 * Rules are evaluated in order, so put specific paths before their prefixes.
 * An empty section list hides the help button on that route.
 */
const ROUTE_RULES: { test: (pathname: string) => boolean; sections: string[] }[] = [
  // You're already reading the SOPs here.
  { test: (p) => p === "/help", sections: [] },

  { test: (p) => p === "/", sections: ["high-level-walkthrough", "overview-key-highlights"] },

  { test: (p) => p === "/import", sections: ["how-to-import-data", "how-to-filter-clean-verify"] },

  // Single-record pages: the actions available are re-verify email/phone.
  { test: (p) => /^\/companies\/[^/]+$/.test(p), sections: ["how-to-filter-clean-verify"] },
  { test: (p) => /^\/people\/[^/]+$/.test(p), sections: ["how-to-filter-clean-verify"] },

  // Companies has Clean Names, Re-verify Email, and Clay/EmailBison pushes.
  // It has no GHL push (GHL is phone-based, so people-only), so the GHL SOP is
  // deliberately absent here.
  {
    test: (p) => p === "/companies",
    sections: [
      "how-to-filter-clean-verify",
      "emailbison-campaign-operations",
      "how-to-push-to-clay",
      "how-to-push-back-from-clay",
    ],
  },
  {
    test: (p) => p === "/people",
    sections: [
      "how-to-filter-clean-verify",
      "how-to-push-contacts-to-ghl",
      "emailbison-campaign-operations",
      "how-to-push-to-clay",
      "how-to-push-back-from-clay",
    ],
  },

  // Push job monitoring: both platforms land here, so lead with the page tour
  // and offer both push SOPs alongside it.
  {
    test: (p) => p === "/push-activity" || p === "/push-history",
    sections: [
      "high-level-walkthrough",
      "emailbison-campaign-operations",
      "how-to-push-contacts-to-ghl",
    ],
  },

  { test: (p) => p === "/team", sections: ["how-to-invite-a-team-member"] },
  { test: (p) => p === "/clients", sections: ["how-to-add-a-new-client"] },

  // No dedicated SOP; the walkthrough covers both pages in its tour.
  { test: (p) => p === "/tickets" || p === "/activity", sections: ["high-level-walkthrough"] },
];

const BY_ID = new Map(SECTION_META.map((s) => [s.id, s]));

if (process.env.NODE_ENV !== "production") {
  for (const rule of ROUTE_RULES) {
    for (const id of rule.sections) {
      if (!BY_ID.has(id)) {
        console.warn(`[help-route-map] unknown help section id: ${id}`);
      }
    }
  }
}

/**
 * Resolves the help sections for a pathname. Returns `primary: null` for routes
 * with no relevant SOP (auth pages, /help itself), which hides the help button.
 */
export function helpForPath(pathname: string): {
  primary: HelpSectionMeta | null;
  related: HelpSectionMeta[];
} {
  const rule = ROUTE_RULES.find((r) => r.test(pathname));
  const matched = (rule?.sections ?? [])
    .map((id) => BY_ID.get(id))
    .filter((s): s is HelpSectionMeta => Boolean(s));

  return { primary: matched[0] ?? null, related: matched.slice(1) };
}
