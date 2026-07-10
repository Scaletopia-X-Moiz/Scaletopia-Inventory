"use server";

import { revalidatePath } from "next/cache";
import { requireUser, canManageTickets, canChangeTicketStatus } from "@/lib/auth/dal";
import { logActivity } from "@/lib/activity/log";
import {
  createTicket,
  deleteTicket,
  getTicketById,
  updateTicketContent,
  updateTicketNote,
  updateTicketStatus,
  type TicketCategory,
  type TicketStatus,
} from "@/lib/data/tickets";

export interface ActionState {
  error?: string;
  success?: boolean;
}

const CATEGORIES: TicketCategory[] = ["bug", "feature_request", "improvement"];
const STATUSES: TicketStatus[] = ["open", "in_progress", "done"];
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;

/** Any authenticated role can file a ticket. Used by the "+ Add Ticket" modal. */
export async function createTicketAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const category = String(formData.get("category") ?? "");

  if (!title) return { error: "Title is required." };
  if (title.length > MAX_TITLE) return { error: "Title is too long." };
  if (!description) return { error: "Description is required." };
  if (description.length > MAX_DESCRIPTION) return { error: "Description is too long." };
  if (!CATEGORIES.includes(category as TicketCategory)) {
    return { error: "Choose a category." };
  }

  const ticket = await createTicket({
    title,
    description,
    category: category as TicketCategory,
    createdBy: user.id,
  });

  await logActivity("ticket.create", { ticket_id: ticket.id, title: ticket.title }, user);
  revalidatePath("/tickets");
  return { success: true };
}

/** admin/dev only — editing title/description/category is off-limits to the
 * reporter once filed (tickets are immutable to members after creation). */
export async function updateTicketContentAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();
  if (!canManageTickets(user.role)) return { error: "Not allowed." };

  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return { error: "Invalid ticket." };

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const category = String(formData.get("category") ?? "");

  if (!title) return { error: "Title is required." };
  if (title.length > MAX_TITLE) return { error: "Title is too long." };
  if (!description) return { error: "Description is required." };
  if (description.length > MAX_DESCRIPTION) return { error: "Description is too long." };
  if (!CATEGORIES.includes(category as TicketCategory)) {
    return { error: "Choose a category." };
  }

  const existing = await getTicketById(id, user.role, user.id);
  if (!existing) return { error: "Ticket not found." };

  await updateTicketContent(id, { title, description, category: category as TicketCategory });
  await logActivity("ticket.update", { ticket_id: id, title }, user);
  revalidatePath("/tickets");
  return { success: true };
}

/** dev only — the one right admin does not have. */
export async function updateTicketStatusAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();
  if (!canChangeTicketStatus(user.role)) return { error: "Not allowed." };

  const id = Number(formData.get("id"));
  const status = String(formData.get("status") ?? "");
  if (!Number.isFinite(id)) return { error: "Invalid ticket." };
  if (!STATUSES.includes(status as TicketStatus)) return { error: "Invalid status." };

  const existing = await getTicketById(id, user.role, user.id);
  if (!existing) return { error: "Ticket not found." };
  if (existing.status === status) return { success: true };

  await updateTicketStatus(id, status as TicketStatus);
  await logActivity(
    "ticket.status_change",
    { ticket_id: id, from: existing.status, to: status },
    user
  );
  revalidatePath("/tickets");
  return { success: true };
}

/** admin/dev only — the note is a single mutable field, overwritten each time,
 * not a thread. */
export async function updateTicketNoteAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();
  if (!canManageTickets(user.role)) return { error: "Not allowed." };

  const id = Number(formData.get("id"));
  const note = String(formData.get("note") ?? "").trim();
  if (!Number.isFinite(id)) return { error: "Invalid ticket." };

  const existing = await getTicketById(id, user.role, user.id);
  if (!existing) return { error: "Ticket not found." };
  if (!note) return { error: "Note cannot be empty." };

  await updateTicketNote(id, note, user.id);
  await logActivity("ticket.note_update", { ticket_id: id }, user);
  revalidatePath("/tickets");
  return { success: true };
}

/** admin/dev only — hard delete, no soft-delete/deleted_at. */
export async function deleteTicketAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();
  if (!canManageTickets(user.role)) return { error: "Not allowed." };

  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return { error: "Invalid ticket." };

  const existing = await getTicketById(id, user.role, user.id);
  if (!existing) return { error: "Ticket not found." };

  await deleteTicket(id);
  await logActivity("ticket.delete", { ticket_id: id, title: existing.title }, user);
  revalidatePath("/tickets");
  return { success: true };
}
