"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Dialog } from "radix-ui";
import { Check, Loader2, Plus, X } from "lucide-react";
import type { ClientRow } from "@/lib/data/clients";
import {
  createClientAction,
  updateClientField,
  type ClientCredentialField,
  type CreateClientState,
} from "./actions";

type TextField = Exclude<ClientCredentialField, "isActive">;

const TEXT_FIELDS: { field: TextField; label: string; sensitive?: boolean }[] = [
  { field: "ghlApiKey", label: "GHL API key", sensitive: true },
  { field: "ghlLocationId", label: "GHL location ID" },
  { field: "emailbisonApiKey", label: "EmailBison API key", sensitive: true },
  { field: "emailbisonWorkspaceId", label: "EmailBison workspace ID" },
];

function EditableCell({
  clientId,
  field,
  initialValue,
  sensitive,
}: {
  clientId: string;
  field: ClientCredentialField;
  initialValue: string | null;
  sensitive?: boolean;
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
        type={sensitive ? "password" : "text"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        placeholder="—"
        autoComplete="off"
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

function AddClientDialog() {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<CreateClientState | undefined, FormData>(
    createClientAction,
    undefined
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.success) {
      formRef.current?.reset();
      setOpen(false);
    }
  }, [state]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="flex items-center justify-center gap-2 rounded-lg bg-stamp px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          <Plus size={15} />
          Add client
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-rule bg-card p-5 shadow-xl outline-none">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-sm font-semibold text-ink">New client</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-ink-soft">
                Creates a client row with credentials left blank — fill in GHL details after.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-hover"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <form ref={formRef} action={action} className="flex flex-col gap-3">
            <div>
              <label htmlFor="client-name" className="mb-1 block text-xs font-medium text-ink-soft">
                Name
              </label>
              <input
                id="client-name"
                name="name"
                type="text"
                required
                maxLength={200}
                placeholder="Acme Agency"
                className="w-full rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
              />
            </div>

            <div>
              <label htmlFor="client-slug" className="mb-1 block text-xs font-medium text-ink-soft">
                Slug <span className="text-ink-mute">(optional — derived from name)</span>
              </label>
              <input
                id="client-slug"
                name="slug"
                type="text"
                placeholder="acme"
                className="w-full rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
              />
              <p className="mt-1 text-xs text-ink-mute">
                Matches the GHL_&lt;CLIENT&gt;_API_KEY env-var naming, lowercase. Must be unique.
              </p>
            </div>

            {state?.error && <p className="text-xs text-danger">{state.error}</p>}

            <div className="mt-1 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-lg border border-rule px-4 py-2 text-sm text-ink-soft transition-colors hover:bg-hover"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={pending}
                className="flex items-center justify-center gap-2 rounded-lg bg-stamp px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {pending ? <Loader2 size={15} className="animate-spin" /> : null}
                Create client
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ClientsView({ clients }: { clients: ClientRow[] }) {
  if (clients.length === 0) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-xl border border-rule bg-card p-6 text-sm text-ink-soft">
        <p>No clients yet.</p>
        <AddClientDialog />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <AddClientDialog />
      </div>
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
                {TEXT_FIELDS.map(({ field, sensitive }) => (
                  <td key={field} className="px-4 py-3">
                    <EditableCell
                      clientId={client.id}
                      field={field}
                      initialValue={client[field]}
                      sensitive={sensitive}
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
    </div>
  );
}
