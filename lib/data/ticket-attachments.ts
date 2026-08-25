import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TICKET_ATTACHMENTS_BUCKET } from "@/lib/tickets/storage";

export type TicketAttachmentKind = "image" | "audio";
export type TicketAttachmentContext = "report" | "note";

export interface TicketAttachmentRow {
  id: number;
  ticketId: number;
  kind: TicketAttachmentKind;
  context: TicketAttachmentContext;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  originalName: string | null;
  createdBy: string;
  createdAt: string;
  // Only populated by getTicketAttachmentsWithUrls — omitted elsewhere so
  // list/index queries never accidentally imply a signed URL was resolved.
  signedUrl?: string;
}

interface RawTicketAttachmentRow {
  id: number;
  ticket_id: number;
  kind: TicketAttachmentKind;
  context: TicketAttachmentContext;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  original_name: string | null;
  created_by: string;
  created_at: string;
}

const ATTACHMENT_COLUMNS =
  "id,ticket_id,kind,context,storage_path,mime_type,size_bytes,duration_ms,original_name,created_by,created_at";

const SIGNED_URL_TTL_SECONDS = 3600;

function toTicketAttachmentRow(raw: RawTicketAttachmentRow): TicketAttachmentRow {
  return {
    id: raw.id,
    ticketId: raw.ticket_id,
    kind: raw.kind,
    context: raw.context,
    storagePath: raw.storage_path,
    mimeType: raw.mime_type,
    sizeBytes: raw.size_bytes,
    durationMs: raw.duration_ms,
    originalName: raw.original_name,
    createdBy: raw.created_by,
    createdAt: raw.created_at,
  };
}

export interface InsertTicketAttachmentInput {
  ticketId: number;
  kind: TicketAttachmentKind;
  context: TicketAttachmentContext;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number | null;
  originalName?: string | null;
  createdBy: string;
}

/** Inserts a single attachment row — used for note attachments, added one at
 * a time as staff record them against an already-existing ticket. */
export async function insertTicketAttachment(
  input: InsertTicketAttachmentInput
): Promise<TicketAttachmentRow> {
  const { data, error } = await supabaseAdmin
    .from("ticket_attachments")
    .insert({
      ticket_id: input.ticketId,
      kind: input.kind,
      context: input.context,
      storage_path: input.storagePath,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      duration_ms: input.durationMs ?? null,
      original_name: input.originalName ?? null,
      created_by: input.createdBy,
    })
    .select(ATTACHMENT_COLUMNS)
    .single();

  if (error) throw error;
  return toTicketAttachmentRow(data as unknown as RawTicketAttachmentRow);
}

export interface NewTicketAttachmentItem {
  kind: TicketAttachmentKind;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number | null;
  originalName?: string | null;
}

/** Bulk-inserts attachments for a ticket that was just created — used by
 * createTicketAction to link everything the reporter uploaded before the
 * ticket id existed. */
export async function insertTicketAttachments(
  ticketId: number,
  items: NewTicketAttachmentItem[],
  createdBy: string,
  context: TicketAttachmentContext = "report"
): Promise<TicketAttachmentRow[]> {
  if (items.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("ticket_attachments")
    .insert(
      items.map((item) => ({
        ticket_id: ticketId,
        kind: item.kind,
        context,
        storage_path: item.storagePath,
        mime_type: item.mimeType,
        size_bytes: item.sizeBytes,
        duration_ms: item.durationMs ?? null,
        original_name: item.originalName ?? null,
        created_by: createdBy,
      }))
    )
    .select(ATTACHMENT_COLUMNS);

  if (error) throw error;
  return ((data ?? []) as unknown as RawTicketAttachmentRow[]).map(toTicketAttachmentRow);
}

export async function getTicketAttachments(ticketId: number): Promise<TicketAttachmentRow[]> {
  const { data, error } = await supabaseAdmin
    .from("ticket_attachments")
    .select(ATTACHMENT_COLUMNS)
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return ((data ?? []) as unknown as RawTicketAttachmentRow[]).map(toTicketAttachmentRow);
}

export async function getTicketAttachmentById(id: number): Promise<TicketAttachmentRow | null> {
  const { data, error } = await supabaseAdmin
    .from("ticket_attachments")
    .select(ATTACHMENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return toTicketAttachmentRow(data as unknown as RawTicketAttachmentRow);
}

/** Short-TTL signed URL for rendering one attachment. Returns null (rather
 * than throwing) on failure so a single bad row doesn't take down the whole
 * drawer — callers should treat a null signedUrl as "unavailable". */
export async function getSignedAttachmentUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage
    .from(TICKET_ATTACHMENTS_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (error || !data) return null;
  return data.signedUrl;
}

/**
 * Fetches one ticket's attachments with signed URLs already resolved, split
 * by context (report vs note). This is deliberately NOT part of
 * getTickets/getTicketById — signing N storage URLs per ticket is fine for a
 * single open detail drawer but far too expensive to do for every row in a
 * list. Callers should only reach for this when rendering a single ticket.
 */
export async function getTicketAttachmentsWithUrls(
  ticketId: number
): Promise<{ report: TicketAttachmentRow[]; note: TicketAttachmentRow[] }> {
  const rows = await getTicketAttachments(ticketId);
  const withUrls = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      signedUrl: (await getSignedAttachmentUrl(row.storagePath)) ?? undefined,
    }))
  );

  return {
    report: withUrls.filter((row) => row.context === "report"),
    note: withUrls.filter((row) => row.context === "note"),
  };
}

/** Deletes the row and best-effort removes the backing storage object. A
 * storage-removal failure is logged but doesn't fail the delete — the row is
 * already gone, and an orphaned object just wastes a little storage rather
 * than leaving the UI in an inconsistent state. */
export async function deleteTicketAttachment(id: number): Promise<void> {
  const { data, error: fetchError } = await supabaseAdmin
    .from("ticket_attachments")
    .select("storage_path")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!data) return;

  const { error: deleteError } = await supabaseAdmin
    .from("ticket_attachments")
    .delete()
    .eq("id", id);
  if (deleteError) throw deleteError;

  const { error: storageError } = await supabaseAdmin.storage
    .from(TICKET_ATTACHMENTS_BUCKET)
    .remove([(data as { storage_path: string }).storage_path]);
  if (storageError) {
    console.warn(`[tickets] failed to remove storage object for attachment ${id}:`, storageError);
  }
}
