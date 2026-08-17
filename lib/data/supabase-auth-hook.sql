-- ─────────────────────────────────────────────────────────────────────────────
-- Custom Access Token Hook — injects a `user_role` claim from
-- public.profiles.role into every access token Supabase Auth issues.
--
-- Run ONCE in the Supabase dashboard → SQL Editor (after supabase-auth.sql,
-- which creates public.profiles). Idempotent — safe to re-run.
--
-- This function only PREPARES the hook. It has no effect until it is wired up
-- in the dashboard:
--   Authentication → Hooks (Beta) → "Customize Access Token (JWT) Claims hook"
--   → Postgres → select `public.custom_access_token_hook` → Enable.
--
-- See Slice 3 (issue #29) of docs/prds/app-wide-navigation-and-dashboard-latency.md.
-- The DAL (lib/auth/dal.ts) does NOT read this claim yet — that's Slice 4
-- (issue #30). This slice only establishes the claim.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  user_role text;
begin
  select role into user_role
  from public.profiles
  where id = (event ->> 'user_id')::uuid;

  claims := event -> 'claims';

  if user_role is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(user_role));
  else
    claims := jsonb_set(claims, '{user_role}', to_jsonb('member'::text));
  end if;

  event := jsonb_set(event, '{claims}', claims);

  return event;
end;
$$;

-- Supabase Auth runs the hook as `supabase_auth_admin`, which by default has
-- no access to application tables. Grant just enough for the function above.
grant usage on schema public to supabase_auth_admin;

grant execute
  on function public.custom_access_token_hook
  to supabase_auth_admin;

revoke execute
  on function public.custom_access_token_hook
  from authenticated, anon, public;

grant select
  on table public.profiles
  to supabase_auth_admin;

drop policy if exists "Allow auth admin to read roles" on public.profiles;
create policy "Allow auth admin to read roles"
  on public.profiles
  as permissive
  for select
  to supabase_auth_admin
  using (true);
