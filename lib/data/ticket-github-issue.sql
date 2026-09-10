-- ─────────────────────────────────────────────────────────────────────────────
-- Mirrored GitHub issue column for Scaletopia Inventory tickets
--
-- Run this ONCE in the Supabase dashboard → SQL Editor, after
-- supabase-tickets.sql has already been applied. It is idempotent, so
-- re-running it is safe. Adds a nullable `github_issue` column to
-- public.tickets holding the number of the GitHub issue that mirrors the
-- ticket. The in-app ticket stays the source of truth; the issue is only the
-- durable work log, so this is null until a dev starts work on the ticket.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.tickets
  add column if not exists github_issue integer;
