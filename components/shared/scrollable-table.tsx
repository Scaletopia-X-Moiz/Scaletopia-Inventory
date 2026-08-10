"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const BAR_HEIGHT = 14;

/**
 * Wraps a wide table in a horizontally-scrolling container plus a second
 * scrollbar that stays pinned to the bottom of the *visible* viewport, so
 * the scrollbar stays reachable even when the table has more rows than fit
 * on screen — the native scrollbar on the table container itself would only
 * be visible after scrolling the page all the way down.
 *
 * The proxy bar is positioned with `position: fixed`, computed in JS from
 * the nearest scrolling ancestor's bounding rect, rather than relying on
 * `position: sticky`. `sticky`'s containing block here is this component's
 * own wrapper div, which is exactly as tall as the table — there's no
 * "extra room" within that wrapper for the sticky element to travel through
 * as the page scrolls relative to the *actual* scrolling ancestor (the
 * page's `<main>`), so it never reliably ends up pinned to the visible
 * bottom edge. Tracking the scroll container's rect directly sidesteps that
 * containing-block mismatch entirely and keeps working regardless of what
 * wraps this component on a given page.
 */
export function ScrollableTable({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const [bar, setBar] = useState<{ left: number; width: number; bottom: number } | null>(null);
  const syncingFrom = useRef<"body" | "scrollbar" | null>(null);

  const recompute = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;

    const sw = body.scrollWidth;
    setScrollWidth(sw);

    const overflowing = sw > body.clientWidth + 1;
    if (!overflowing) {
      setBar(null);
      return;
    }

    const bodyRect = body.getBoundingClientRect();
    const scrollParent = scrollParentRef.current;
    const parentRect = scrollParent?.getBoundingClientRect();
    const viewportTop = parentRect ? parentRect.top : 0;
    const viewportBottom = parentRect ? parentRect.bottom : window.innerHeight;

    // Only show the bar while some part of the table is actually within the
    // visible scroll area — otherwise it'd float over unrelated content
    // above/below the table.
    const visible = bodyRect.top < viewportBottom && bodyRect.bottom > viewportTop;
    if (!visible) {
      setBar(null);
      return;
    }

    // Rest the bar at the table's own bottom edge once that scrolls above
    // the visible area (mirrors how a sticky footer detaches at the end of
    // its container), otherwise pin it to the visible viewport's bottom.
    const barBottomEdge = Math.min(bodyRect.bottom, viewportBottom);
    setBar({
      left: bodyRect.left,
      width: bodyRect.width,
      bottom: Math.max(0, window.innerHeight - barBottomEdge),
    });
  }, []);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    // Find the nearest ancestor that actually establishes a vertical scroll
    // container (e.g. the page's `<main>`); fall back to the window.
    let el: HTMLElement | null = body.parentElement;
    let found: HTMLElement | null = null;
    while (el) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        found = el;
        break;
      }
      el = el.parentElement;
    }
    scrollParentRef.current = found;

    recompute();

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        recompute();
        ticking = false;
      });
    };

    const ro = new ResizeObserver(onScroll);
    ro.observe(body);

    const scrollTarget: HTMLElement | Window = scrollParentRef.current ?? window;
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    return () => {
      ro.disconnect();
      scrollTarget.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [recompute]);

  const onBodyScroll = () => {
    if (syncingFrom.current === "scrollbar") {
      syncingFrom.current = null;
      return;
    }
    if (bodyRef.current && scrollbarRef.current) {
      syncingFrom.current = "body";
      scrollbarRef.current.scrollLeft = bodyRef.current.scrollLeft;
    }
  };

  const onScrollbarScroll = () => {
    if (syncingFrom.current === "body") {
      syncingFrom.current = null;
      return;
    }
    if (bodyRef.current && scrollbarRef.current) {
      syncingFrom.current = "scrollbar";
      bodyRef.current.scrollLeft = scrollbarRef.current.scrollLeft;
    }
  };

  return (
    <div>
      <div
        ref={bodyRef}
        onScroll={onBodyScroll}
        className={cn(
          "scroll-x-visible overflow-x-auto rounded-lg border border-rule",
          className,
        )}
      >
        {children}
      </div>
      {bar && (
        <div
          ref={scrollbarRef}
          onScroll={onScrollbarScroll}
          className="scroll-x-visible fixed z-20 overflow-x-auto overflow-y-hidden rounded-b-lg border-x border-b border-rule bg-card shadow-[0_-1px_4px_rgba(0,0,0,0.08)]"
          style={{ left: bar.left, width: bar.width, bottom: bar.bottom, height: BAR_HEIGHT }}
          aria-hidden
        >
          <div style={{ width: scrollWidth, height: 1 }} />
        </div>
      )}
    </div>
  );
}
