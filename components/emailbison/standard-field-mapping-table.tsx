"use client";

import type { EmailBisonStandardFieldMapping } from "@/lib/emailbison/types";

const STANDARD_FIELD_ROWS: { key: keyof EmailBisonStandardFieldMapping; label: string }[] = [
  { key: "companyName", label: "Company name" },
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
 * in behavior. Reworked to free-form source mapping, mirroring the CSV
 * importer's "Map Columns" screen (app/import/page.tsx's MappingTable):
 * EmailBison's 7 destination fields are fixed, but each row's `<select>`
 * picks WHICH of the caller's `columns` feeds it, with "— ignore —" (value
 * "skip") first — matching the importer's "ignore" option and this file's
 * prior "skip" sentinel. The caller pre-populates `value` via
 * resolveDefaultFieldMapping before rendering; this component is just a
 * controlled set of dropdowns over it. */
export function StandardFieldMappingTable({
  value,
  columns,
  onChange,
}: {
  value: EmailBisonStandardFieldMapping;
  /** The source options offered per row — bindable People/Company-table
   * columns plus active virtual/enrichment columns, same set the
   * custom-variable editor's column-bound rows offer. */
  columns: { key: string; label: string }[];
  onChange: (next: EmailBisonStandardFieldMapping) => void;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-ink">Standard fields</p>
      <p className="mt-1 text-xs text-ink-mute">
        Choose which column feeds each EmailBison field. Ignored fields aren&apos;t sent.
      </p>
      <div className="mt-2 overflow-hidden rounded-md border border-rule">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-rule bg-hover">
              <th className="px-2 py-1.5 text-left font-medium text-ink-soft">EmailBison field</th>
              <th className="px-2 py-1.5 text-left font-medium text-ink-soft">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {STANDARD_FIELD_ROWS.map((row) => (
              <tr key={row.key}>
                <td className="px-2 py-1.5 text-ink">{row.label}</td>
                <td className="px-2 py-1.5">
                  <select
                    value={value[row.key]}
                    onChange={(e) => onChange({ ...value, [row.key]: e.target.value })}
                    className="w-full rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                  >
                    <option value="skip">— ignore —</option>
                    {columns.map((col) => (
                      <option key={col.key} value={col.key}>
                        {col.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
