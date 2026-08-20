"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { SECTIONS, type Block, type HelpSection, type ListItem } from "./help-content";

/** Renders `backtick` spans as inline code, everything else as plain text. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code
            key={i}
            className="rounded bg-hover px-1 py-0.5 font-mono text-[0.8125em] text-ink"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  );
}

function ListItems({ items }: { items: ListItem[] }) {
  return (
    <>
      {items.map((item, i) => {
        const text = typeof item === "string" ? item : item.text;
        const sub = typeof item === "string" ? undefined : item.sub;
        return (
          <li key={i}>
            <RichText text={text} />
            {sub?.length ? (
              <ul className="mt-1.5 list-disc space-y-1 pl-5">
                {sub.map((s, j) => (
                  <li key={j}>
                    <RichText text={s} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "h":
      return (
        <h3 className="mt-5 mb-2 text-sm font-semibold text-ink first:mt-0">
          {block.text}
        </h3>
      );
    case "p":
      return (
        <p className="mb-3 text-sm leading-relaxed text-ink-soft">
          <RichText text={block.text} />
        </p>
      );
    case "ul":
      return (
        <ul className="mb-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-soft">
          <ListItems items={block.items} />
        </ul>
      );
    case "ol":
      return (
        <ol className="mb-3 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-ink-soft">
          <ListItems items={block.items} />
        </ol>
      );
    case "note":
      return (
        <p className="mb-3 rounded-lg border border-rule bg-hover px-3 py-2 text-sm leading-relaxed text-ink-soft">
          <RichText text={block.text} />
        </p>
      );
    case "code":
      return (
        <pre className="mb-3 overflow-x-auto rounded-lg border border-rule bg-hover px-3 py-2 font-mono text-xs leading-relaxed text-ink">
          {block.text}
        </pre>
      );
    case "table":
      return (
        <div className="mb-3 overflow-x-auto rounded-lg border border-rule">
          <table className="w-full border-collapse text-sm text-ink-soft">
            <thead>
              <tr className="border-b border-rule bg-hover">
                {block.head.map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left text-xs font-medium text-ink"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-b border-rule last:border-0">
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-2 align-top">
                      <RichText text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function HelpAccordion({
  section,
  open,
  onToggle,
}: {
  section: HelpSection;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      id={section.id}
      className="scroll-mt-4 overflow-hidden rounded-xl border border-rule bg-card"
    >
      <button
        type="button"
        onClick={onToggle}
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
              {section.loomEmbedUrl ? (
                <div className="relative mb-5 w-full overflow-hidden rounded-lg border border-rule pt-[56.25%]">
                  <iframe
                    src={section.loomEmbedUrl}
                    title={`${section.title} walkthrough video`}
                    allow="fullscreen; picture-in-picture; autoplay; clipboard-write; encrypted-media"
                    allowFullScreen
                    loading="lazy"
                    className="absolute inset-0 h-full w-full"
                  />
                </div>
              ) : (
                <p className="mb-5 rounded-lg border border-dashed border-rule px-3 py-4 text-center text-xs text-ink-mute">
                  Video coming soon
                </p>
              )}

              {section.blocks.map((block, i) => (
                <BlockView key={i} block={block} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Opens (and scrolls to) the section named by the URL hash, e.g.
 * `/help#how-to-import-data`. Used by the topbar help popover's "View more".
 */
export function HelpView() {
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback((id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const openFromHash = () => {
      const id = window.location.hash.slice(1);
      if (!id || !SECTIONS.some((s) => s.id === id)) return;
      setOpenIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      // Wait for the accordion to expand before scrolling to it.
      requestAnimationFrame(() => {
        containerRef.current
          ?.querySelector(`#${CSS.escape(id)}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    };

    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  return (
    <div ref={containerRef} className="flex flex-col gap-3">
      {SECTIONS.map((section) => (
        <HelpAccordion
          key={section.id}
          section={section}
          open={openIds.has(section.id)}
          onToggle={() => toggle(section.id)}
        />
      ))}
    </div>
  );
}
