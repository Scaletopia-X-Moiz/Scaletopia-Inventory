import type { BindableColumn } from "@/lib/push/company-source";

/** The <option>s for a push dialog's column <select>: the record/person
 * columns first, then any company custom_data fields under their own
 * "Company fields" group so a person key and a company key of the same name
 * can't be confused (see lib/push/company-source.ts). */
export function BindableColumnOptions({ columns }: { columns: BindableColumn[] }) {
  const own = columns.filter((col) => col.group !== "company");
  const company = columns.filter((col) => col.group === "company");
  return (
    <>
      {own.map((col) => (
        <option key={col.key} value={col.key}>
          {col.label}
        </option>
      ))}
      {company.length > 0 ? (
        <optgroup label="Company fields">
          {company.map((col) => (
            <option key={col.key} value={col.key}>
              {col.label}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );
}
