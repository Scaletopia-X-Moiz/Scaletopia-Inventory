-- ─────────────────────────────────────────────────────────────────────────────
-- Ticket priority column for Scaletopia Inventory
--
-- Run this ONCE in the Supabase dashboard → SQL Editor, after
-- supabase-tickets.sql has already been applied. It is idempotent, so
-- re-running it is safe. Adds a `priority` column to public.tickets with 5
-- levels (urgent, high, medium, low, nice_to_have), defaulting to 'medium'.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.tickets
  add column if not exists priority text not null default 'medium'
    check (priority in ('urgent', 'high', 'medium', 'low', 'nice_to_have'));

create index if not exists tickets_priority_idx on public.tickets (priority);
