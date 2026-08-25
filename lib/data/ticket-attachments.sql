-- ─────────────────────────────────────────────────────────────────────────────
-- Ticket attachments schema for Scaletopia Inventory
--
-- Run this ONCE in the Supabase dashboard → SQL Editor, after
-- supabase-tickets.sql has already been applied. It is idempotent, so
-- re-running it is safe.
--
-- public.ticket_attachments holds images and voice notes attached either to
-- a ticket's initial report (context='report', added at creation time) or to
-- its current_note (context='note', added by staff editing the note). The
-- underlying file bytes live in Supabase Storage (bucket "ticket-attachments",
-- private) — this table just tracks metadata + storage_path.
--
-- Like tickets/profiles/activity_log, this table has RLS enabled with NO
-- permissive policies. It is only reachable via the service-role key (our
-- server code); all authorization is enforced in application code in
-- lib/data/ticket-attachments.ts and lib/auth/dal.ts.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.ticket_attachments (
  id             bigint generated always as identity primary key,
  ticket_id      bigint not null references public.tickets (id) on delete cascade,
  kind           text not null check (kind in ('image', 'audio')),
  context        text not null default 'report' check (context in ('report', 'note')),
  storage_path   text not null,
  mime_type      text not null,
  size_bytes     bigint not null,
  duration_ms    integer,
  original_name  text,
  created_by     uuid not null references public.profiles (id),
  created_at     timestamptz not null default now()
);

create index if not exists ticket_attachments_ticket_id_idx on public.ticket_attachments (ticket_id);

alter table public.ticket_attachments enable row level security;
-- no permissive policies — enforced app-level via supabaseAdmin, matching tickets/profiles/activity_log

-- Manual step (not SQL): confirm/create the "ticket-attachments" storage
-- bucket. app/api/tickets/attachments/upload/route.ts auto-creates it on
-- first use (getBucket → createBucket({ public: false }), tolerating
-- already-exists races), so no manual bucket creation is strictly required —
-- but if you'd rather create it up front in the dashboard, mark it private.
