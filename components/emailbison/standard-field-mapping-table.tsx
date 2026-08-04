"use client";

import type { EmailBisonStandardFieldMapping } from "@/lib/emailbison/types";

const INCLUDE_SKIP_ROWS: {
  key: Exclude<keyof EmailBisonStandardFieldMapping, "companyName">;
  label: string;
}[] = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "title", label: "Title" },
  { key: "website", label: "Website" },
];

/** Standard-field mapping table shown above the custom-variable editor on
 * every "Add to EmailBison" options step (People — ticket #112, Companies —
 * ticket #113) — one shared component so the two entry points can't diverge
 * in behavior. The caller pre-populates `value` via resolveDefaultFieldMapping
 * before rendering; this component is just a controlled set of dropdowns over
 * it. */
export function StandardFieldMappingTable({
  value,
  onChange,
}: {
  value: EmailBisonStandardFieldMapping;
  onChange: (next: EmailBisonStandardFieldMapping) => void;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-ink">Standard fields</p>
      <p className="mt-1 text-xs text-ink-mute">
        Choose which standard EmailBison lead fields to send, and where company name comes from.
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3 rounded-md border border-rule px-2 py-1.5 text-xs">
          <span className="text-ink">Company name</span>
          <select
            value={value.companyName}
            onChange={(e) =>
              onChange({
                ...value,
                companyName: e.target.value as EmailBisonStandardFieldMapping["companyName"],
              })
            }
            className="rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
          >
            <option value="brand_name">Cleaned brand name</option>
            <option value="company_name">Raw company name</option>
            <option value="skip">Skip</option>
          </select>
        </div>
        {INCLUDE_SKIP_ROWS.map((row) => (
          <div
            key={row.key}
            className="flex items-center justify-between gap-3 rounded-md border border-rule px-2 py-1.5 text-xs"
          >
            <span className="text-ink">{row.label}</span>
            <select
              value={value[row.key]}
              onChange={(e) => onChange({ ...value, [row.key]: e.target.value as "include" | "skip" })}
              className="rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
            >
              <option value="include">Include</option>
              <option value="skip">Skip</option>
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
