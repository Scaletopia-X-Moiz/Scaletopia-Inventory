-- T46 / #147: add an "awaiting_reply" ticket status ("Waiting on you" in the
-- UI), used to park a ticket back on the requester when we need an answer. The
-- status column is gated by a CHECK constraint, so a new value requires
-- widening it. Reversible: re-add the three-value form to roll back.
alter table public.tickets drop constraint tickets_status_check;

alter table public.tickets
  add constraint tickets_status_check
  check (status = any (array['open', 'in_progress', 'awaiting_reply', 'done']));
