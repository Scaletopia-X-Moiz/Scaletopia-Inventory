"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Wraps a wide table in a horizontally-scrolling container plus a second
 * scrollbar pinned to the bottom of the viewport (via `sticky`), so the
 * scrollbar stays reachable even when the table has more rows than fit on
 * screen — the native scrollbar on the table container itself would only be
 * visible after scrolling the page all the way down.
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
  const [scrollWidth, setScrollWidth] = useState(0);
  const [overflowing, setOverflowing] = useState(false);
  const syncingFrom = useRef<"body" | "scrollbar" | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const update = () => {
      setScrollWidth(body.scrollWidth);
      setOverflowing(body.scrollWidth > body.clientWidth + 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

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
        className={cn("overflow-x-auto rounded-lg border border-rule", className)}
      >
        {children}
      </div>
      {overflowing && (
        <div
          ref={scrollbarRef}
          onScroll={onScrollbarScroll}
          className="sticky bottom-0 z-10 overflow-x-auto overflow-y-hidden rounded-b-lg border-x border-b border-rule bg-card"
          style={{ height: 14 }}
          aria-hidden
        >
          <div style={{ width: scrollWidth, height: 1 }} />
        </div>
      )}
    </div>
  );
}
