"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { motion, useInView } from "framer-motion";
import { ArrowUpRight, Building2, Users, Layers, Cable, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

type Variant = "blue" | "purple" | "plain";

const VARIANT_STYLES: Record<Variant, { bg: string; iconColor: string; border: string }> = {
  blue: {
    bg: "bg-blue-500/10",
    iconColor: "text-blue-400",
    border: "border-transparent",
  },
  purple: {
    bg: "bg-purple-500/10",
    iconColor: "text-purple-400",
    border: "border-transparent",
  },
  plain: {
    bg: "",
    iconColor: "text-stamp",
    border: "border-rule",
  },
};

const ICON_MAP: Record<string, React.ReactNode> = {
  companies: <Building2 className="w-5 h-5" />,
  people: <Users className="w-5 h-5" />,
  niches: <Layers className="w-5 h-5" />,
  sources: <Cable className="w-5 h-5" />,
  pushes: <Send className="w-5 h-5" />,
};

function CardInner({
  label,
  value,
  hint,
  variant,
  icon,
  isHovered,
  isInView,
  href,
}: {
  label: string;
  value: number;
  hint?: string;
  variant: Variant;
  icon: string;
  isHovered: boolean;
  isInView: boolean;
  href?: string;
}) {
  const v = VARIANT_STYLES[variant];
  return (
    <Card
      className={cn(
        "gap-3 px-6 py-6 transition-all group hover-lift",
        href ? "cursor-pointer" : "cursor-default",
        v.bg,
        v.border,
        variant !== "plain" && "shadow-none",
      )}
    >
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-ink-mute uppercase tracking-wide transition-colors duration-200 group-hover:text-ink-soft">
          {label}
        </p>
        <motion.div
          className={cn("opacity-60 group-hover:opacity-100", v.iconColor)}
          animate={isHovered ? { rotate: 10, scale: 1.15 } : { rotate: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 400, damping: 20 }}
        >
          {ICON_MAP[icon] || ICON_MAP.companies}
        </motion.div>
      </div>
      <div className="flex items-end justify-between gap-2">
        <motion.span
          className="text-3xl font-bold tabular-nums tracking-tight text-ink"
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ delay: 0.2, duration: 0.3 }}
        >
          {value.toLocaleString("en-US")}
        </motion.span>
        {hint ? (
          <motion.span
            className="flex items-center gap-0.5 whitespace-nowrap pb-1 text-xs font-medium text-success"
            initial={{ opacity: 0, x: 8 }}
            animate={isInView ? { opacity: 1, x: 0 } : {}}
            transition={{ delay: 0.4 }}
            whileHover={{ scale: 1.05 }}
          >
            {hint}
            <ArrowUpRight size={13} />
          </motion.span>
        ) : null}
      </div>
    </Card>
  );
}

export function StatCard({
  label,
  value,
  hint,
  variant = "plain",
  icon = label.toLowerCase(),
  href,
}: {
  label: string;
  value: number;
  hint?: string;
  variant?: Variant;
  icon?: string;
  href?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { once: true, margin: "-20px" });
  const [isHovered, setIsHovered] = useState(false);

  const inner = (
    <CardInner
      label={label}
      value={value}
      hint={hint}
      variant={variant}
      icon={icon}
      isHovered={isHovered}
      isInView={isInView}
      href={href}
    />
  );

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0, y: 16 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
    >
      {href ? <Link href={href}>{inner}</Link> : inner}
    </motion.div>
  );
}
