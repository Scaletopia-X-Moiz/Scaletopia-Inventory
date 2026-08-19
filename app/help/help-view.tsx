"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A single help topic. `steps` are rendered as an ordered list; `loomEmbedUrl`
 * is the Loom *embed* URL (https://www.loom.com/embed/<id>), not the share URL.
 *
 * PLACEHOLDER CONTENT — real guides and video links get filled in later. The
 * accordion + embed wiring below is final; only this array needs editing.
 */
type HelpSection = {
  id: string;
  title: string;
  steps: string[];
  loomEmbedUrl?: string;
};

const SECTIONS: HelpSection[] = [
  {
    id: "how-to-import",
    title: "How to import",
    steps: [
      "Placeholder step one — describe how to open the Import page.",
      "Placeholder step two — describe uploading the file.",
      "Placeholder step three — describe mapping columns and confirming.",
    ],
    // loomEmbedUrl: "https://www.loom.com/embed/REPLACE_ME",
  },
  {
    id: "how-to-push-emailbison",
    title: "How to push to EmailBison",
    steps: [
      "Placeholder step one.",
      "Placeholder step two.",
    ],
    // loomEmbedUrl: "https://www.loom.com/embed/REPLACE_ME",
  },
  {
    id: "how-to-push-ghl",
    title: "How to push to GHL",
    steps: [
      "Placeholder step one.",
      "Placeholder step two.",
    ],
    // loomEmbedUrl: "https://www.loom.com/embed/REPLACE_ME",
  },
];

function HelpAccordion({ section }: { section: HelpSection }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-xl border border-rule bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-hover"
      >
        <span className="text-sm font-medium text-ink">{section.title}</span>
        <ChevronDown
          size={16}
          className={cn(
            "shrink-0 text-ink-mute transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-rule px-4 py-4">
              <ol className="mb-4 list-decimal space-y-1.5 pl-5 text-sm text-ink-soft">
                {section.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>

              {section.loomEmbedUrl ? (
                <div className="relative w-full overflow-hidden rounded-lg border border-rule pt-[56.25%]">
                  <iframe
                    src={section.loomEmbedUrl}
                    title={`${section.title} — walkthrough video`}
                    allowFullScreen
                    className="absolute inset-0 h-full w-full"
                  />
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-rule px-3 py-4 text-center text-xs text-ink-mute">
                  Video coming soon
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function HelpView() {
  return (
    <div className="flex flex-col gap-3">
      {SECTIONS.map((section) => (
        <HelpAccordion key={section.id} section={section} />
      ))}
    </div>
  );
}
