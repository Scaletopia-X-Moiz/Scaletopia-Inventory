"use client";

import { Dialog } from "radix-ui";
import { HelpCircle } from "lucide-react";

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
          <div className="flex w-full items-center justify-center rounded-lg border border-dashed border-rule bg-hover py-16 text-sm text-ink-soft">
            Video coming soon — will be added here.
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
