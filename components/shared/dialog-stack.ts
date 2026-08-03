"use client";

import { useEffect, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// A tiny module-level "how many AlertDialogs are currently open" counter.
//
// Issue #89: the post-push "Remove temporary columns?" prompt
// (people-results-client.tsx / companies-results-client.tsx) used to open
// unconditionally as soon as a push's `onDone` fired — but for the push
// buttons that show a persistent "Push complete" summary step (GHL,
// EmailBison, EmailBison "Add to Campaign"), `onDone` fires *while that
// summary AlertDialog is still open*, so the temp-columns prompt stacked
// right on top of it, obscuring the push result.
//
// Rather than build a full dialog-manager abstraction, push-button dialogs
// register their own open/closed state here via useRegisterDialogOpen, and
// callers that want to avoid opening over an existing dialog can check
// useAnyDialogOpen() (or subscribe imperatively via onAnyDialogOpenChange)
// and defer until it's false.
// ---------------------------------------------------------------------------

let openCount = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return openCount;
}

function getServerSnapshot(): number {
  return 0;
}

/** Registers this component's own AlertDialog/Dialog as open for as long as
 * `isOpen` is true. Call unconditionally at the top of any dialog-owning
 * component; the effect handles adding/removing itself from the shared
 * count. */
export function useRegisterDialogOpen(isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return;
    openCount++;
    notify();
    return () => {
      openCount--;
      notify();
    };
  }, [isOpen]);
}

/** True while at least one dialog registered via useRegisterDialogOpen is
 * open. Use this to defer opening a new, unrelated dialog until the current
 * one closes (issue #89). */
export function useAnyDialogOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) > 0;
}

/** Synchronous point-in-time read, for callers that need to check "is
 * anything open right now" from inside an event handler (e.g. a push
 * button's onDone) rather than render. */
export function isAnyDialogOpen(): boolean {
  return openCount > 0;
}

/** Subscribes to open/close changes on the shared dialog stack. Prefer this
 * over a plain `useEffect` + `useAnyDialogOpen()` when the reaction needs to
 * setState only once, later, in response to the stack draining (e.g. "show
 * this prompt as soon as nothing else is open") — calling setState from
 * inside the subscription callback, rather than synchronously in an effect
 * body, avoids re-running the deferred action on every unrelated render. */
export function subscribeToDialogStack(listener: () => void): () => void {
  return subscribe(listener);
}
