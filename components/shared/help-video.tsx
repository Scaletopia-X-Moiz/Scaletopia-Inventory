"use client";

import { Dialog } from "radix-ui";
import { HelpCircle } from "lucide-react";

const LOOM_EMBED_URL = "https://www.loom.com/embed/6fcf9708990544279419fd3400c3400f";

export function HelpVideo() {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-soft hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-stamp/50"
          aria-label="Help: platform walkthrough video"
        >
          <HelpCircle size={17} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-xl border border-rule bg-popover p-4 shadow-2xl outline-none">
          <Dialog.Title className="mb-3 text-sm font-medium text-ink">
            Platform walkthrough
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            A short video guide to using Scaletopia Inventory
          </Dialog.Description>
          <div className="relative w-full overflow-hidden rounded-lg" style={{ paddingBottom: "62.5%" }}>
            <iframe
              src={LOOM_EMBED_URL}
              title="Platform walkthrough"
              allow="fullscreen"
              className="absolute inset-0 h-full w-full"
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
