-- ─────────────────────────────────────────────────────────────────────────────
-- Tickets schema for Scaletopia Inventory
--
-- Run this ONCE in the Supabase dashboard → SQL Editor, after supabase-auth.sql
-- has already been applied. It is idempotent, so re-running it is safe.
--
-- Adds:
--   1. A `dev` role option on public.profiles (in addition to admin/member).
--   2. public.tickets — bug/feature/improvement reports with a single mutable
--      status and a single mutable "current note" field (no thread, no
--      separate notes table — each note update overwrites the last).
--
-- Like profiles/activity_log, tickets has RLS enabled with NO permissive
-- policies. It is only reachable via the service-role key (our server code);
-- all authorization (who can view/edit/change status/delete) is enforced in
-- application code in lib/data/tickets.ts and lib/auth/dal.ts.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add the `dev` role ──────────────────────────────────────────────────────
-- dev is effectively admin + the right to change ticket status; admin has
-- everything dev has except changing ticket status. See app/team for the role
-- selector and lib/auth/dal.ts for the permission helpers.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('admin', 'member', 'dev'));

-- 2. Tickets ─────────────────────────────────────────────────────────────────
create table if not exists public.tickets (
  id               bigint generated always as identity primary key,
  title            text not null,
  description      text not null,
  category         text not null check (category in ('bug', 'feature_request', 'improvement')),
  status           text not null default 'open' check (status in ('open', 'in_progress', 'done')),
  priority         text not null default 'medium'
                     check (priority in ('urgent', 'high', 'medium', 'low', 'nice_to_have')),
  created_by       uuid not null references public.profiles (id),
  current_note     text,
  note_updated_by  uuid references public.profiles (id),
  note_updated_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists tickets_status_idx on public.tickets (status);
create index if not exists tickets_priority_idx on public.tickets (priority);
create index if not exists tickets_created_by_idx on public.tickets (created_by);

alter table public.tickets enable row level security;
-- no permissive policies — enforced app-level via supabaseAdmin, matching profiles/activity_log
