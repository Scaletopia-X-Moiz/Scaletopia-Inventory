import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Role } from "@/lib/auth/dal";
import type { TicketPriority } from "@/lib/tickets/priority";

export type TicketCategory = "bug" | "feature_request" | "improvement";
export type TicketStatus = "open" | "in_progress" | "done";
export type { TicketPriority };
export type TicketTab = "open" | "done" | "all";

export interface TicketListFilters {
  tab: TicketTab;
}

export interface TicketRow {
  id: number;
  title: string;
  description: string;
  category: TicketCategory;
  status: TicketStatus;
  priority: TicketPriority;
  createdBy: string;
  createdByEmail: string | null;
  currentNote: string | null;
  noteUpdatedBy: string | null;
  noteUpdatedByEmail: string | null;
  noteUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawTicketRow {
  id: number;
  title: string;
  description: string;
  category: TicketCategory;
  status: TicketStatus;
  priority: TicketPriority;
  created_by: string;
  current_note: string | null;
  note_updated_by: string | null;
  note_updated_at: string | null;
  created_at: string;
  updated_at: string;
  creator: { email: string | null } | { email: string | null }[] | null;
  note_author: { email: string | null } | { email: string | null }[] | null;
}

const TICKET_COLUMNS =
  "id,title,description,category,status,priority,created_by,current_note,note_updated_by,note_updated_at,created_at,updated_at," +
  "creator:profiles!tickets_created_by_fkey(email),note_author:profiles!tickets_note_updated_by_fkey(email)";

function firstOf<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function toTicketRow(raw: RawTicketRow): TicketRow {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    category: raw.category,
    status: raw.status,
    priority: raw.priority,
    createdBy: raw.created_by,
    createdByEmail: firstOf(raw.creator)?.email ?? null,
    currentNote: raw.current_note,
    noteUpdatedBy: raw.note_updated_by,
    noteUpdatedByEmail: firstOf(raw.note_author)?.email ?? null,
    noteUpdatedAt: raw.note_updated_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/**
 * Lists tickets scoped by role and tab. Members only ever see their own
 * tickets (created_by = viewerId); admin/dev see everything. The "open" tab
 * bundles open + in_progress so newly-started work doesn't disappear from
 * the default view; "done" and "all" are literal.
 */
export async function getTickets(
  filters: TicketListFilters,
  viewerRole: Role,
  viewerId: string
): Promise<TicketRow[]> {
  let query = supabaseAdmin
    .from("tickets")
    .select(TICKET_COLUMNS)
    .order("created_at", { ascending: false });

  if (viewerRole === "member") {
    query = query.eq("created_by", viewerId);
  }

  if (filters.tab === "open") {
    query = query.in("status", ["open", "in_progress"]);
  } else if (filters.tab === "done") {
    query = query.eq("status", "done");
  }

  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as unknown as RawTicketRow[]).map(toTicketRow);
}

/**
 * Fetches a single ticket. Returns null if it doesn't exist OR the viewer
 * isn't allowed to see it (member viewing someone else's ticket) — callers
 * should treat both the same way (404), never leaking existence.
 */
export async function getTicketById(
  id: number,
  viewerRole: Role,
  viewerId: string
): Promise<TicketRow | null> {
  const { data, error } = await supabaseAdmin
    .from("tickets")
    .select(TICKET_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = toTicketRow(data as unknown as RawTicketRow);
  if (viewerRole === "member" && row.createdBy !== viewerId) return null;
  return row;
}

export interface CreateTicketInput {
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  createdBy: string;
}

export async function createTicket(input: CreateTicketInput): Promise<TicketRow> {
  const { data, error } = await supabaseAdmin
    .from("tickets")
    .insert({
      title: input.title,
      description: input.description,
      category: input.category,
      priority: input.priority,
      created_by: input.createdBy,
    })
    .select(TICKET_COLUMNS)
    .single();

  if (error) throw error;
  return toTicketRow(data as unknown as RawTicketRow);
}

export interface UpdateTicketContentInput {
  title?: string;
  description?: string;
  category?: TicketCategory;
  priority?: TicketPriority;
}

export async function updateTicketContent(
  id: number,
  input: UpdateTicketContentInput
): Promise<TicketRow> {
  const { data, error } = await supabaseAdmin
    .from("tickets")
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(TICKET_COLUMNS)
    .single();

  if (error) throw error;
  return toTicketRow(data as unknown as RawTicketRow);
}

export async function updateTicketStatus(
  id: number,
  status: TicketStatus
): Promise<TicketRow> {
  const { data, error } = await supabaseAdmin
    .from("tickets")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(TICKET_COLUMNS)
    .single();

  if (error) throw error;
  return toTicketRow(data as unknown as RawTicketRow);
}

export async function updateTicketNote(
  id: number,
  note: string,
  updatedBy: string
): Promise<TicketRow> {
  const { data, error } = await supabaseAdmin
    .from("tickets")
    .update({
      current_note: note,
      note_updated_by: updatedBy,
      note_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(TICKET_COLUMNS)
    .single();

  if (error) throw error;
  return toTicketRow(data as unknown as RawTicketRow);
}

export async function deleteTicket(id: number): Promise<void> {
  const { error } = await supabaseAdmin.from("tickets").delete().eq("id", id);
  if (error) throw error;
}
