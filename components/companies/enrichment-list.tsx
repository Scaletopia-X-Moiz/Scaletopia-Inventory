export function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

export function EnrichmentList({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-rule px-5 py-6 text-center text-sm italic text-ink-soft">
        No enrichment data
      </div>
    );
  }

  return (
    <ol className="divide-y divide-rule rounded-lg border border-rule">
      {entries.map(([key, value]) => (
        <li key={key} className="flex items-baseline gap-3 px-5 py-2.5">
          <span className="w-1/3 shrink-0 truncate text-xs font-medium text-ink-soft">{key}</span>
          <span className="flex-1 text-sm text-ink">{formatValue(value)}</span>
        </li>
      ))}
    </ol>
  );
}
