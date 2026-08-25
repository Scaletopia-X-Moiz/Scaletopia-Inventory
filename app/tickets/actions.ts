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
import { PRIORITY_OPTIONS, type TicketPriority } from "@/lib/tickets/priority";
import {
  deleteTicketAttachment,
  getTicketAttachmentById,
  getTicketAttachmentsWithUrls,
  insertTicketAttachment,
  insertTicketAttachments,
  type TicketAttachmentKind,
  type TicketAttachmentRow,
} from "@/lib/data/ticket-attachments";
import {
  isAllowedAudioType,
  isAllowedImageType,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  normalizeMimeType,
} from "@/lib/tickets/storage";

export interface ActionState {
  error?: string;
  success?: boolean;
}

const CATEGORIES: TicketCategory[] = ["bug", "feature_request", "improvement"];
const STATUSES: TicketStatus[] = ["open", "in_progress", "done"];
const PRIORITIES: TicketPriority[] = PRIORITY_OPTIONS;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_ATTACHMENTS_PER_TICKET = 10;

interface PendingAttachmentInput {
  storagePath: string;
  kind: TicketAttachmentKind;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  originalName?: string;
}

function validateAttachmentFields(
  kind: unknown,
  mimeType: string,
  sizeBytes: number
): string | null {
  if (kind !== "image" && kind !== "audio") return "Invalid attachment type.";
  if (kind === "image" && !isAllowedImageType(mimeType)) return "Unsupported image type.";
  if (kind === "audio" && !isAllowedAudioType(mimeType)) return "Unsupported audio type.";
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "Invalid attachment size.";
  const maxBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  if (sizeBytes > maxBytes) return "Attachment is too large.";
  return null;
}

/** Parses+validates the hidden `attachments` JSON field the create-ticket
 * dialog submits (an array of items the client already uploaded to storage
 * via /api/tickets/attachments/upload). Every field is re-validated
 * server-side — the client's mime/size checks are only a UX nicety. */
function parseAttachmentsField(
  raw: FormDataEntryValue | null
): PendingAttachmentInput[] | { error: string } {
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { error: "Invalid attachments payload." };
  }
  if (!Array.isArray(parsed)) return { error: "Invalid attachments payload." };
  if (parsed.length > MAX_ATTACHMENTS_PER_TICKET) {
    return { error: `You can attach up to ${MAX_ATTACHMENTS_PER_TICKET} files.` };
  }

  const items: PendingAttachmentInput[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return { error: "Invalid attachments payload." };
    const item = entry as Record<string, unknown>;
    const storagePath = String(item.storagePath ?? "");
    const mimeType = normalizeMimeType(String(item.mimeType ?? ""));
    const sizeBytes = Number(item.sizeBytes);

    if (!storagePath) return { error: "Invalid attachment." };
    const fieldError = validateAttachmentFields(item.kind, mimeType, sizeBytes);
    if (fieldError) return { error: fieldError };

    items.push({
      storagePath,
      kind: item.kind as TicketAttachmentKind,
      mimeType,
      sizeBytes,
      durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
      originalName: typeof item.originalName === "string" ? item.originalName : undefined,
    });
  }
  return items;
}

/** Any authenticated role can file a ticket. Used by the "+ Add Ticket" modal. */
export async function createTicketAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const category = String(formData.get("category") ?? "");
  const priority = String(formData.get("priority") ?? "medium");

  if (!title) return { error: "Title is required." };
  if (title.length > MAX_TITLE) return { error: "Title is too long." };
  if (!description) return { error: "Description is required." };
  if (description.length > MAX_DESCRIPTION) return { error: "Description is too long." };
  if (!CATEGORIES.includes(category as TicketCategory)) {
    return { error: "Choose a category." };
  }
  if (!PRIORITIES.includes(priority as TicketPriority)) {
    return { error: "Choose a priority." };
  }

  const attachments = parseAttachmentsField(formData.get("attachments"));
  if ("error" in attachments) return { error: attachments.error };

  const ticket = await createTicket({
    title,
    description,
    category: category as TicketCategory,
    priority: priority as TicketPriority,
    createdBy: user.id,
  });

  if (attachments.length > 0) {
    await insertTicketAttachments(ticket.id, attachments, user.id, "report");
  }

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
  const priority = String(formData.get("priority") ?? "medium");

  if (!title) return { error: "Title is required." };
  if (title.length > MAX_TITLE) return { error: "Title is too long." };
  if (!description) return { error: "Description is required." };
  if (description.length > MAX_DESCRIPTION) return { error: "Description is too long." };
  if (!CATEGORIES.includes(category as TicketCategory)) {
    return { error: "Choose a category." };
  }
  if (!PRIORITIES.includes(priority as TicketPriority)) {
    return { error: "Choose a priority." };
  }

  const existing = await getTicketById(id, user.role, user.id);
  if (!existing) return { error: "Ticket not found." };

  await updateTicketContent(id, {
    title,
    description,
    category: category as TicketCategory,
    priority: priority as TicketPriority,
  });
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

/** admin/dev only — attaches one already-uploaded image/voice note to a
 * ticket's note, gated the same as editing the note itself. Called once per
 * file the moment it finishes uploading (see attachment-picker.tsx /
 * voice-recorder.tsx as used from the drawer's NoteEditor), not batched. */
export async function attachTicketNoteFileAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();
  if (!canManageTickets(user.role)) return { error: "Not allowed." };

  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return { error: "Invalid ticket." };

  const existing = await getTicketById(id, user.role, user.id);
  if (!existing) return { error: "Ticket not found." };

  const storagePath = String(formData.get("storagePath") ?? "");
  const kind = String(formData.get("kind") ?? "");
  const mimeType = normalizeMimeType(String(formData.get("mimeType") ?? ""));
  const sizeBytes = Number(formData.get("sizeBytes"));
  const durationMsRaw = formData.get("durationMs");
  const originalNameRaw = formData.get("originalName");

  if (!storagePath) return { error: "Invalid attachment." };
  const fieldError = validateAttachmentFields(kind, mimeType, sizeBytes);
  if (fieldError) return { error: fieldError };

  await insertTicketAttachment({
    ticketId: id,
    kind: kind as TicketAttachmentKind,
    context: "note",
    storagePath,
    mimeType,
    sizeBytes,
    durationMs: durationMsRaw != null && durationMsRaw !== "" ? Number(durationMsRaw) : null,
    originalName: typeof originalNameRaw === "string" && originalNameRaw ? originalNameRaw : null,
    createdBy: user.id,
  });

  await logActivity("ticket.note_attachment_add", { ticket_id: id, kind }, user);
  revalidatePath("/tickets");
  return { success: true };
}

/** Removable by whoever uploaded it, or by anyone who can manage tickets
 * (admin/dev) — same shape as the other ticket mutations. */
export async function removeTicketAttachmentAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  const user = await requireUser();

  const ticketId = Number(formData.get("ticketId"));
  const attachmentId = Number(formData.get("attachmentId"));
  if (!Number.isFinite(ticketId) || !Number.isFinite(attachmentId)) {
    return { error: "Invalid attachment." };
  }

  const existing = await getTicketById(ticketId, user.role, user.id);
  if (!existing) return { error: "Ticket not found." };

  const attachment = await getTicketAttachmentById(attachmentId);
  if (!attachment || attachment.ticketId !== ticketId) return { error: "Attachment not found." };

  const isOwnAttachment = attachment.createdBy === user.id;
  if (!isOwnAttachment && !canManageTickets(user.role)) return { error: "Not allowed." };

  await deleteTicketAttachment(attachmentId);
  await logActivity(
    "ticket.attachment_delete",
    { ticket_id: ticketId, attachment_id: attachmentId },
    user
  );
  revalidatePath("/tickets");
  return { success: true };
}

/** Lazily resolves signed URLs for one ticket's attachments, split by
 * context. Called client-side (not as a form action) when the detail
 * drawer opens — see ticket-detail-drawer.tsx. Deliberately kept out of
 * getTickets/getTicketById so the list view never pays for signing N
 * storage URLs per ticket, only the single open one does. */
export async function getTicketAttachmentsAction(
  ticketId: number
): Promise<{ report: TicketAttachmentRow[]; note: TicketAttachmentRow[] } | { error: string }> {
  const user = await requireUser();
  const existing = await getTicketById(ticketId, user.role, user.id);
  if (!existing) return { error: "Ticket not found." };
  return getTicketAttachmentsWithUrls(ticketId);
}
