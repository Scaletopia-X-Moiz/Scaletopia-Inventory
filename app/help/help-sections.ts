/**
 * The help sections, ordered as they appear on /help.
 *
 * Deliberately free of the SOP prose (that lives in `help-content.ts`) so the
 * topbar help popover can resolve a page's guide without pulling the whole
 * playbook into every route's bundle.
 *
 * `loomEmbedUrl` is the Loom *embed* URL (https://www.loom.com/embed/<id>),
 * not the share URL.
 */
export type HelpSectionMeta = {
  id: string;
  title: string;
  loomEmbedUrl?: string;
};

export const SECTION_META: HelpSectionMeta[] = [
  { id: "overview-key-highlights", title: "Overview & Key Highlights", loomEmbedUrl: "https://www.loom.com/embed/2cb930c870a445bf9b95e56b8ca70bf7" },
  { id: "high-level-walkthrough", title: "High Level Walkthrough", loomEmbedUrl: "https://www.loom.com/embed/ced5093e32064b17b84a6c1baf073e18" },
  { id: "how-to-import-data", title: "How to Import Data", loomEmbedUrl: "https://www.loom.com/embed/a6337ee8fe5f49af846e63977fd38958" },
  { id: "how-to-filter-clean-verify", title: "How to Filter, Clean & Verify Data", loomEmbedUrl: "https://www.loom.com/embed/d1e4750ee55c4d2f9c95f4840317c8aa" },
  { id: "how-to-push-to-clay", title: "How to push data to Clay for enrichments", loomEmbedUrl: "https://www.loom.com/embed/3b1d5b962e5a4cdcbdae2cf6a6492d5f" },
  { id: "how-to-push-back-from-clay", title: "How to push enrichment data back from Clay", loomEmbedUrl: "https://www.loom.com/embed/3b1d5b962e5a4cdcbdae2cf6a6492d5f" },
  { id: "emailbison-campaign-operations", title: "EmailBison Campaign Operations", loomEmbedUrl: "https://www.loom.com/embed/73784a40194d474c9aac746b8ab9bd24" },
  { id: "how-to-push-contacts-to-ghl", title: "How to Push contacts to GHL", loomEmbedUrl: "https://www.loom.com/embed/aefe843f9c8444d2a18ecb9867194a06" },
  { id: "how-to-add-a-new-client", title: "How to Add & Set Up a New Client", loomEmbedUrl: "https://www.loom.com/embed/9302a6a9316e4f649b83e964480a6114" },
  { id: "how-to-invite-a-team-member", title: "How to Invite a New Team Member", loomEmbedUrl: "https://www.loom.com/embed/9147055edde2426596e759ede8d0c35d" },
];
