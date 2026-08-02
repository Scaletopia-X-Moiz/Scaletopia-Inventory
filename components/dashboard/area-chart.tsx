"use client";

import { useCallback, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence, useInView } from "framer-motion";
import { cn, humanizeSlug } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface ChartPoint {
  id?: string;
  label: string;
  count: number;
}
export interface ChartSeries {
  key: string;
  label: string;
  points: ChartPoint[];
  filterParam?: string;
}

const GRADIENTS = [
  { stop: "var(--c-blue)", gradientId: "blue" },
  { stop: "var(--c-purple)", gradientId: "purple" },
  { stop: "var(--c-mint)", gradientId: "mint" },
  { stop: "var(--c-cyan)", gradientId: "cyan" },
];

function coords(points: ChartPoint[]) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const min = Math.min(...points.map((p) => p.count));
  const range = max - min || max;
  const n = points.length;
  return points.map((p, i) => ({
    x: n <= 1 ? 50 : (i / (n - 1)) * 100,
    y: 100 - ((p.count - min) / range) * 80 - 12,
    point: p,
  }));
}

function smoothPath(pts: { x: number; y: number }[], close: boolean) {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  if (close) d += ` L 100 100 L 0 100 Z`;
  return d;
}

interface TooltipData {
  x: number;
  y: number;
  label: string;
  value: number;
  seriesLabel: string;
  color: string;
}

function formatAxisLabel(n: number): string {
  if (n >= 1000000) return `${Math.round(n / 1000000)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export function AreaChart({ title, series }: { title: string; series: ChartSeries[] }) {
  const [activeKey, setActiveKey] = useState(series[0]?.key);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const gradId = useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { once: true, margin: "-20px" });
  const router = useRouter();

  const active = series.find((s) => s.key === activeKey) ?? series[0];
  const seriesIndex = series.indexOf(active);
  const gradInfo = GRADIENTS[seriesIndex % GRADIENTS.length];
  const c = coords(active.points);
  const clickable = !!active.filterParam;

  const handleDotClick = useCallback(
    (pt: ChartPoint) => {
      if (!active.filterParam) return;
      const id = pt.id ?? pt.label;
      router.push(`/companies?${active.filterParam}=${encodeURIComponent(id)}`);
    },
    [active, router],
  );

  const handleDotHover = useCallback(
    (pt: ChartPoint, idx: number, color: string) => {
      const container = chartRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        setTooltip({
          x: (c[idx].x / 100) * rect.width,
          y: (c[idx].y / 100) * rect.height,
          label: humanizeSlug(pt.label),
          value: pt.count,
          seriesLabel: active.label,
          color,
        });
      }
    },
    [active, c],
  );

  const maxVal = Math.max(1, ...active.points.map((p) => p.count));

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0, y: 12 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      <Card className="animate-in transition-shadow hover:shadow-[var(--card-shadow-hover)] hover-lift">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <CardTitle className="text-sm text-ink">{title}</CardTitle>
            <div className="flex items-center gap-4">
              {series.map((s) => {
                const idx = series.indexOf(s);
                const c = GRADIENTS[idx % GRADIENTS.length].stop;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setActiveKey(s.key)}
                    className={cn(
                      "flex items-center gap-1.5 text-sm transition-all",
                      s.key === active.key
                        ? "font-medium text-ink scale-105"
                        : "text-ink-mute hover:text-ink hover:scale-105",
                    )}
                  >
                    <span className="size-2 rounded-full transition-transform" style={{ backgroundColor: c }} />
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          <div ref={chartRef} className="relative h-[260px] w-full">
            <svg
              className="h-full w-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden
            >
              <defs>
                <linearGradient id={`area-${gradId}-${gradInfo.gradientId}`} x1="0" y1="0" x2="0" y2="1">
                  <motion.stop
                    offset="0%"
                    stopColor={gradInfo.stop}
                    initial={{ stopOpacity: 0 }}
                    animate={{ stopOpacity: 0.4 }}
                    transition={{ delay: 0.8, duration: 0.5 }}
                  />
                  <motion.stop
                    offset="100%"
                    stopColor={gradInfo.stop}
                    initial={{ stopOpacity: 0 }}
                    animate={{ stopOpacity: 0 }}
                    transition={{ delay: 0.8, duration: 0.5 }}
                  />
                </linearGradient>
                <filter id={`glow-${gradId}`}>
                  <feGaussianBlur stdDeviation="1.5" result="coloredBlur" />
                  <feMerge>
                    <feMergeNode in="coloredBlur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              {/* Grid lines - only 3 subtle lines, no labels */}
              {[25, 50, 75].map((y) => (
                <motion.line
                  key={y}
                  x1="0"
                  y1={y}
                  x2="100"
                  y2={y}
                  stroke="var(--rule)"
                  strokeWidth="0.5"
                  strokeDasharray="2 2"
                  vectorEffect="non-scaling-stroke"
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ delay: 0.3 + (y / 100) * 0.1, duration: 0.4 }}
                />
              ))}

              {/* Area fill */}
              <motion.path
                d={smoothPath(c, true)}
                fill={`url(#area-${gradId}-${gradInfo.gradientId})`}
                initial={{ opacity: 0 }}
                animate={isInView ? { opacity: 0.5 } : {}}
                transition={{ delay: 0.5, duration: 0.5 }}
              />

              {/* Line */}
              <motion.path
                d={smoothPath(c, false)}
                fill="none"
                stroke={gradInfo.stop}
                strokeWidth="2"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                filter={`url(#glow-${gradId})`}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={isInView ? { pathLength: 1, opacity: 1 } : {}}
                transition={{ delay: 0.3, duration: 0.8, ease: "easeInOut" }}
              />

            </svg>

            {/* Dots — rendered as HTML overlay so the square viewBox's
                non-uniform scaling (preserveAspectRatio="none") doesn't
                stretch them into ellipses */}
            {c.map((d, i) => (
              <motion.div
                key={d.point.label}
                className="absolute size-2.5 rounded-full"
                style={{
                  left: `${d.x}%`,
                  top: `${d.y}%`,
                  transform: "translate(-50%, -50%)",
                  backgroundColor: "var(--card)",
                  border: `1.5px solid ${gradInfo.stop}`,
                  cursor: clickable ? "pointer" : "default",
                }}
                initial={{ scale: 0, opacity: 0 }}
                animate={isInView ? { scale: 1, opacity: 1 } : {}}
                whileHover={clickable ? { scale: 1.5 } : undefined}
                transition={{ delay: 0.3 + i * 0.05, duration: 0.3, type: "spring", stiffness: 300, damping: 20 }}
                onMouseEnter={() => handleDotHover(d.point, i, gradInfo.stop)}
                onMouseLeave={() => setTooltip(null)}
                onClick={clickable ? () => handleDotClick(d.point) : undefined}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                title={clickable ? `Filter by ${humanizeSlug(d.point.label)}` : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleDotClick(d.point);
                        }
                      }
                    : undefined
                }
              />
            ))}

            {/* Tooltip overlay */}
            <AnimatePresence>
              {tooltip && (
                <motion.div
                  className="absolute z-30 pointer-events-none"
                  initial={{ opacity: 0, y: 4, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  style={{
                    left: tooltip.x,
                    top: Math.max(0, tooltip.y - 60),
                    transform: "translateX(-50%)",
                  }}
                >
                  <div className="rounded-lg border border-rule bg-card px-3 py-2 shadow-lg backdrop-blur-sm">
                    <p className="text-xs font-medium text-ink">{tooltip.label}</p>
                    <p className="text-xs text-ink-soft">
                      <span
                        className="inline-block size-2 rounded-full align-middle"
                        style={{ backgroundColor: tooltip.color }}
                      />{" "}
                      {tooltip.value.toLocaleString("en-US")} · {tooltip.seriesLabel}
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Clean X-axis labels below the chart */}
          <div className="flex justify-between gap-1">
            {active.points.map((p, i) => (
              <motion.span
                key={p.label}
                className="flex-1 truncate text-center text-[11px] text-ink-mute"
                initial={{ opacity: 0 }}
                animate={isInView ? { opacity: 1 } : {}}
                transition={{ delay: 0.5 + i * 0.05 }}
              >
                {humanizeSlug(p.label)}
              </motion.span>
            ))}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
