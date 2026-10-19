-- Read-only ticket counts for the Engineer Tickets Overview page
-- (scaletopoia-engineer-tickets, lib/data/databank-overview.ts).
-- Applied 2026-09-29 as migration `ticket_overview_rpc`.
--
-- Exposes counts only (no titles, no people), so it is granted to anon: the
-- Engineer Tickets app calls it with the publishable key and never holds
-- this project's service role key. Rollback:
--   drop function if exists public.ticket_overview();
create or replace function public.ticket_overview()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'open',           count(*) filter (where status = 'open'),
    'in_progress',    count(*) filter (where status = 'in_progress'),
    'awaiting_reply', count(*) filter (where status = 'awaiting_reply'),
    'done',           count(*) filter (where status = 'done'),
    'total',          count(*)
  )
  from public.tickets;
$$;

revoke all on function public.ticket_overview() from public;
grant execute on function public.ticket_overview() to anon, authenticated, service_role;
