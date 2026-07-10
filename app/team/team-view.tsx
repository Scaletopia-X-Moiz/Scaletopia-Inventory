"use client";

import { useActionState } from "react";
import { Loader2, Trash2, UserPlus } from "lucide-react";
import { inviteUser, setRole, removeUser, type InviteState } from "./actions";

export interface Member {
  id: string;
  email: string | null;
  role: "admin" | "member" | "dev";
  created_at: string;
}

function InviteForm() {
  const [state, action, pending] = useActionState<InviteState | undefined, FormData>(
    inviteUser,
    undefined
  );

  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex-1">
        <input
          type="email"
          name="email"
          placeholder="teammate@company.com"
          required
          className="w-full rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
        />
        {state?.error && <p className="mt-1 text-xs text-red-500">{state.error}</p>}
        {state?.success && <p className="mt-1 text-xs text-green-600">{state.success}</p>}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="flex items-center justify-center gap-2 rounded-lg bg-stamp px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
        Send invite
      </button>
    </form>
  );
}

export function TeamView({
  members,
  currentUserId,
}: {
  members: Member[];
  currentUserId: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-rule bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">Invite a teammate</h2>
        <InviteForm />
      </section>

      <section className="overflow-x-auto rounded-xl border border-rule bg-card">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs text-ink-mute">
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isSelf = m.id === currentUserId;
              return (
                <tr key={m.id} className="border-b border-rule/60 last:border-0">
                  <td className="px-4 py-3 text-ink">
                    {m.email ?? "—"}
                    {isSelf && <span className="ml-2 text-xs text-ink-mute">(you)</span>}
                  </td>
                  <td className="px-4 py-3">
                    <form action={setRole}>
                      <input type="hidden" name="userId" value={m.id} />
                      <input type="hidden" name="email" value={m.email ?? ""} />
                      <select
                        name="role"
                        defaultValue={m.role}
                        disabled={isSelf}
                        onChange={(e) => e.currentTarget.form?.requestSubmit()}
                        className="rounded-md border border-rule bg-paper px-2 py-1 text-sm text-ink outline-none focus:border-stamp disabled:opacity-60"
                      >
                        <option value="member">Member</option>
                        <option value="dev">Dev</option>
                        <option value="admin">Admin</option>
                      </select>
                    </form>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!isSelf && (
                      <form action={removeUser} className="inline">
                        <input type="hidden" name="userId" value={m.id} />
                        <input type="hidden" name="email" value={m.email ?? ""} />
                        <button
                          type="submit"
                          title="Remove user"
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-500/10"
                        >
                          <Trash2 size={14} />
                          Remove
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
