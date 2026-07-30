"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import type { ClientRow } from "@/lib/data/clients";
import { updateClientField, type ClientCredentialField } from "./actions";

const TEXT_FIELDS: { field: "ghlApiKey" | "ghlLocationId"; label: string }[] = [
  { field: "ghlApiKey", label: "GHL API key" },
  { field: "ghlLocationId", label: "GHL location ID" },
];

function EditableCell({
  clientId,
  field,
  initialValue,
}: {
  clientId: string;
  field: ClientCredentialField;
  initialValue: string | null;
}) {
  const [value, setValue] = useState(initialValue ?? "");
  const [lastSaved, setLastSaved] = useState(initialValue ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    if (value === lastSaved) return;
    setError(null);
    startTransition(async () => {
      const result = await updateClientField(clientId, field, value);
      if (result.error) {
        setError(result.error);
      } else {
        setLastSaved(value);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        placeholder="—"
        className="w-full min-w-[160px] rounded-md border border-rule bg-paper px-2 py-1 text-sm text-ink outline-none focus:border-stamp"
      />
      {isPending && <Loader2 size={14} className="shrink-0 animate-spin text-ink-mute" />}
      {!isPending && saved && <Check size={14} className="shrink-0 text-green-600" />}
      {!isPending && error && <span className="shrink-0 text-xs text-red-500">{error}</span>}
    </div>
  );
}

function ActiveToggle({ clientId, initialValue }: { clientId: string; initialValue: boolean }) {
  const [active, setActive] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle() {
    const next = !active;
    setActive(next);
    setError(null);
    startTransition(async () => {
      const result = await updateClientField(clientId, "isActive", next);
      if (result.error) {
        setActive(!next);
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={active}
          onChange={toggle}
          disabled={isPending}
          className="h-4 w-4 rounded border-rule disabled:opacity-60"
        />
        <span className="text-sm text-ink-soft">{active ? "Active" : "Inactive"}</span>
      </label>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}

export function ClientsView({ clients }: { clients: ClientRow[] }) {
  if (clients.length === 0) {
    return (
      <div className="rounded-xl border border-rule bg-card p-6 text-sm text-ink-soft">
        No clients yet. Add one directly in Supabase to get started.
      </div>
    );
  }

  return (
    <section className="overflow-x-auto rounded-xl border border-rule bg-card">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-rule text-left text-xs text-ink-mute">
            <th className="px-4 py-3 font-medium">Client</th>
            {TEXT_FIELDS.map(({ field, label }) => (
              <th key={field} className="px-4 py-3 font-medium">
                {label}
              </th>
            ))}
            <th className="px-4 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => (
            <tr key={client.id} className="border-b border-rule/60 last:border-0">
              <td className="px-4 py-3 text-ink">
                {client.name}
                <span className="ml-2 text-xs text-ink-mute">{client.slug}</span>
              </td>
              {TEXT_FIELDS.map(({ field }) => (
                <td key={field} className="px-4 py-3">
                  <EditableCell
                    clientId={client.id}
                    field={field}
                    initialValue={client[field]}
                  />
                </td>
              ))}
              <td className="px-4 py-3">
                <ActiveToggle clientId={client.id} initialValue={client.isActive} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
