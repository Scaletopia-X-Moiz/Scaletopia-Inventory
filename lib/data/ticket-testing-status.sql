-- Add a "testing" ticket status (between "in_progress" and "done") so the
-- /tickets page can show a Testing tab. The status column is gated by a CHECK
-- constraint, so a new value requires widening it. Reversible: re-add the
-- four-value form (without 'testing') to roll back, after moving any testing
-- tickets to another status.
alter table public.tickets drop constraint tickets_status_check;

alter table public.tickets
  add constraint tickets_status_check
  check (status = any (array['open', 'in_progress', 'testing', 'awaiting_reply', 'done']));
