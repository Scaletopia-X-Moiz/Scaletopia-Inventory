-- ─────────────────────────────────────────────────────────────────────────────
-- Loom walkthrough column for Scaletopia Inventory tickets
--
-- Run this ONCE in the Supabase dashboard → SQL Editor. Idempotent, so
-- re-running it is safe. Adds a nullable `loom_url` column to public.tickets:
-- the dev's Loom recording of the fix, shown to the ticket's creator.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.tickets
  add column if not exists loom_url text;
