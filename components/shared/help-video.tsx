"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "radix-ui";
import { ArrowRight, HelpCircle, X } from "lucide-react";
import { helpForPath } from "@/app/help/help-route-map";

/**
 * Topbar help button. Shows the walkthrough Loom for the page you're currently
 * on (see `helpForPath`), plus a "View more" link into /help with that section
 * already expanded.
 */
export function HelpVideo() {
  const pathname = usePathname();
  const { primary, related } = helpForPath(pathname);

  if (!primary) return null;

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-soft hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-stamp/50"
          aria-label={`Help: ${primary.title}`}
        >
          <HelpCircle size={17} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-rule bg-popover p-4 shadow-2xl outline-none">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-medium text-ink">
                {primary.title}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-ink-mute">
                Walkthrough video for this page
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close"
              className="-mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-mute hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-stamp/50"
            >
              <X size={15} />
            </Dialog.Close>
          </div>

          {primary.loomEmbedUrl ? (
            <div className="relative w-full overflow-hidden rounded-lg border border-rule pt-[56.25%]">
              <iframe
                src={primary.loomEmbedUrl}
                title={`${primary.title} walkthrough video`}
                allow="fullscreen; picture-in-picture; autoplay; clipboard-write; encrypted-media"
                allowFullScreen
                className="absolute inset-0 h-full w-full"
              />
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-rule px-3 py-8 text-center text-xs text-ink-mute">
              Video coming soon
            </p>
          )}

          <Dialog.Close asChild>
            <Link
              href={`/help#${primary.id}`}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50"
            >
              View more
              <ArrowRight size={13} />
            </Link>
          </Dialog.Close>

          {related.length > 0 && (
            <div className="mt-4 border-t border-rule pt-3">
              <p className="mb-2 text-xs font-medium text-ink-soft">
                Related guides
              </p>
              <ul className="flex flex-col gap-1">
                {related.map((section) => (
                  <li key={section.id}>
                    <Dialog.Close asChild>
                      <Link
                        href={`/help#${section.id}`}
                        className="-mx-1.5 flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-xs text-ink-soft transition-colors hover:bg-hover hover:text-ink"
                      >
                        {section.title}
                        <ArrowRight size={12} className="shrink-0 text-ink-mute" />
                      </Link>
                    </Dialog.Close>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
