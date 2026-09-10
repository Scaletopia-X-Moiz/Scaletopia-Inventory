---
name: ticket
description: Work on a ticket from this app's own /tickets tracker. Mirrors it to a GitHub issue, keeps a running log there, and closes both when done.
argument-hint: "<ticket number>"
disable-model-invocation: true
---

The user gave you a ticket number. Tickets live in this app's Supabase `tickets`
table (the `/tickets` page), NOT in GitHub. GitHub is only used as the work log,
so the notes survive between sessions and between the user's two machines.

All database reads and writes go through `scripts/ticket.ts`. Never query the
`tickets` table directly.

## Writing style

Everything you write to GitHub or to a ticket note is read by a human. Never
use em dashes. Use a full stop, a comma, or brackets instead. This applies to
issue titles, issue bodies, every comment, and the closing note in the app.

## Starting or resuming

1. Read the ticket:

   npx tsx scripts/ticket.ts show <number>

   This prints the title, description, category, priority, status, and the
   GitHub issue number if one already exists.

2. If it already has a GitHub issue, this is a RESUME. Read the whole thread:

   gh issue view <issue> --comments

   Catch up on what was already decided and done, tell the user where things
   stand in two or three lines, then carry on. Skip the rest of this section.

3. If it has no GitHub issue, this is a START. Create one:

   gh issue create --title "[T<number>] <ticket title>" --label app-ticket \
     --body "<the ticket description, plus: Source of truth is the in-app ticket #<number>.>"

   Create the `app-ticket` label first if it does not exist.

4. Link the issue back to the ticket and mark it in progress:

   npx tsx scripts/ticket.ts start <number> --issue <issue>

5. Read the code you will need to touch. Then post your plan as a comment on
   the issue, and say the same thing to the user. Use this exact skeleton:

   ## Plan

   **Asking for:** <what the ticket is actually asking for>

   **Changing:** <which files you will change>

   **Verifying:** <how you will check it works>

   Keep the blank lines between the fields. GitHub renders a single newline as
   a soft break, so without them the three fields cram into one dense block.

   If the ticket is vague, ask the user before writing this — do not guess.

## While working

Work on `main`. Do not create branches.

Post a note on the issue whenever something happens that you would not want to
figure out twice. The command takes a type, a one-line summary, what happened,
and why it matters, and formats them into the log for you:

  npx tsx scripts/ticket.ts note <number> <type> "<summary>" "<what>" "<why it matters>"

The type is one of, and only one of: decision, dead-end, migration, gotcha,
blocked. That closed list is what keeps the thread skimmable — do not invent
new ones. Log a note when you hit one of those: a decision and its reason, an
approach that failed, a migration you ran, a gotcha in the codebase, a blocker.
Do not log routine edits — the commits already show those.

Commit as you go. Put the ticket in the message:

  git commit -m "feat(companies): add employee size column (T<number>, #<issue>)"

Push to `main` when the user asks, not automatically.

## Finishing

Only when the user says the work is done.

1. Suggest what the user should write in the ticket itself, in the inventory
   interface at `/tickets`. Give them a short draft they can paste in — a
   couple of sentences, plain language, no file names or jargon, written for
   whoever raised the ticket. Say what now works and that the ticket is
   closed. Do not claim it is still being tested.

2. Post the closing comment and close the issue:

   gh issue close <issue> --comment "<summary>"

   The summary uses this exact skeleton:

   ## Closing summary

   **What changed:** <what changed>

   **Why this way:** <why it was done that way>

   **How it was tested:** <how it was tested>

3. Mark the ticket done in the app:

   npx tsx scripts/ticket.ts done <number> "<short note>"

   That note is shown to whoever raised the ticket, so write it for a
   non-technical reader. One or two sentences, no file names.

4. Tell the user what is left, if anything.
