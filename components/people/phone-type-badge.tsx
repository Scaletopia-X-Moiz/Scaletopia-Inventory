const TYPE_LABEL: Record<string, string> = {
  mobile: "Mobile",
  toll_free: "Toll-free",
  landline: "Landline",
  voip: "VoIP",
  // ClearoutPhone returns this when carrier data can't distinguish the two —
  // confirmed live, not in the original (mobile/toll_free/landline) set.
  fixed_line_or_mobile: "Mobile/Landline",
};

export function PhoneTypeBadge({ phone, type }: { phone: string | null; type: string | null }) {
  if (!phone || !type) return null;

  return (
    <span className="inline-flex items-center rounded-full bg-rule/50 px-2 py-0.5 text-[11px] font-medium text-ink-soft">
      {TYPE_LABEL[type] ?? type}
    </span>
  );
}
