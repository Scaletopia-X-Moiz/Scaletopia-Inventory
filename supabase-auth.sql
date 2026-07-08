-- ─────────────────────────────────────────────────────────────────────────────
-- Auth + activity log schema for Scaletopia Inventory
--
-- Run this ONCE in the Supabase dashboard → SQL Editor. It is idempotent, so
-- re-running it is safe.
--
-- Supabase Auth already provides the `auth.users` table (emails + hashed
-- passwords + sessions). This migration adds:
--   1. public.profiles   — one row per user, holds their role (admin | member)
--   2. public.activity_log — append-only record of who did what, and when
--
-- Both tables have RLS enabled with NO permissive policies, so they are only
-- reachable via the service-role key (our server code). The browser's anon key
-- is used solely for sign-in and can never read these tables directly.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Profiles ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  role       text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Auto-create a profile whenever a new auth user is created (invite accepted).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any users that already exist.
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- 2. Activity log ────────────────────────────────────────────────────────────
create table if not exists public.activity_log (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users (id) on delete set null,
  user_email text,
  action     text not null,              -- e.g. 'import.run', 'clay.push', 'user.invite'
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_log_created_at_idx
  on public.activity_log (created_at desc);

alter table public.activity_log enable row level security;

-- 3. Bootstrap your first admin ──────────────────────────────────────────────
-- After you (the owner) have been invited / created your account, run this once
-- with your own email to grant yourself admin rights:
--
--   update public.profiles set role = 'admin' where email = 'you@example.com';
