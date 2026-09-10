/**
 * CLI for the /ticket workflow (see .claude/skills/ticket/SKILL.md).
 *
 * The in-app Supabase `tickets` table is the source of truth; a mirrored
 * GitHub issue is used as the durable work log. Run by hand:
 *
 *   npx tsx scripts/ticket.ts show <n>
 *   npx tsx scripts/ticket.ts start <n> --issue <i>
 *   npx tsx scripts/ticket.ts note <n> "<text>"
 *   npx tsx scripts/ticket.ts done <n> "<note>"
 *
 * `note` posts to GitHub only and never touches the database; everything
 * else writes to `tickets`.
 *
 * Deliberately does not import lib/data/tickets.ts or lib/supabase/admin.ts:
 * both pull in the "server-only" marker package, which throws unconditionally
 * outside a Next.js server bundle. This script builds its own client instead,
 * matching scripts/audit-niche-tagging.ts.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
}
const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

// The dev running this CLI, as the app knows them — this is the `profiles`
// row (role "dev"), NOT the git commit email, which is a different address.
// `create` records them as the ticket author and `done` as the note author,
// mirroring what updateTicketNote in lib/data/tickets.ts writes from the app.
const DEV_EMAIL = "moizpriv47@gmail.com";

const TICKET_COLUMNS =
  "id,title,description,category,status,priority,github_issue,created_by,current_note,note_updated_by,note_updated_at,created_at,updated_at," +
  "creator:profiles!tickets_created_by_fkey(email)";

interface TicketRow {
  id: number;
  title: string;
  description: string;
  category: string;
  status: string;
  priority: string;
  github_issue: number | null;
  created_by: string;
  current_note: string | null;
  note_updated_by: string | null;
  note_updated_at: string | null;
  created_at: string;
  updated_at: string;
  creator: { email: string | null } | { email: string | null }[] | null;
}

const USAGE = `Usage:
  npx tsx scripts/ticket.ts show <n>
  npx tsx scripts/ticket.ts describe <n> "<description>"
  npx tsx scripts/ticket.ts create "<title>" "<description>" [--category bug|feature_request|improvement] [--priority urgent|high|medium|low|nice_to_have]
  npx tsx scripts/ticket.ts start <n> --issue <i>
  npx tsx scripts/ticket.ts note <n> "<text>"
  npx tsx scripts/ticket.ts done <n> "<note>"`;

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseTicketNumber(raw: string | undefined): number {
  if (!raw) fail(`missing ticket number.\n\n${USAGE}`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) fail(`"${raw}" is not a valid ticket number (expected a positive integer).`);
  return n;
}

async function fetchTicket(id: number): Promise<TicketRow> {
  const { data, error } = await supabase.from("tickets").select(TICKET_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail(`could not read ticket ${id}: ${error.message}`);
  if (!data) fail(`no ticket ${id} — check the number on the /tickets page.`);
  return data as unknown as TicketRow;
}

/** Resolves the dev's profile id so `done` never writes a null note author. */
async function fetchDevProfileId(): Promise<string> {
  const { data, error } = await supabase.from("profiles").select("id").eq("email", DEV_EMAIL).maybeSingle();
  if (error) fail(`could not look up the profile for ${DEV_EMAIL}: ${error.message}`);
  if (!data) fail(`no profile found for ${DEV_EMAIL} — cannot record the note author.`);
  return (data as { id: string }).id;
}

/** Shells out to the GitHub CLI, translating the usual setup failures. */
function runGh(args: string[]): void {
  try {
    execFileSync("gh", args, { stdio: "inherit" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      fail('the "gh" CLI is not installed or not on PATH — install it from https://cli.github.com and run `gh auth login`.');
    }
    fail(`\`gh ${args.join(" ")}\` failed — check that you are authenticated (\`gh auth status\`) and the issue exists.`);
  }
}

async function show(id: number): Promise<void> {
  const t = await fetchTicket(id);
  const creator = Array.isArray(t.creator) ? t.creator[0] : t.creator;
  console.log(`Ticket #${t.id}: ${t.title}`);
  console.log(`  Category:     ${t.category}`);
  console.log(`  Priority:     ${t.priority}`);
  console.log(`  Status:       ${t.status}`);
  console.log(`  GitHub issue: ${t.github_issue ?? "(none — run start to link one)"}`);
  console.log(`  Created by:   ${creator?.email ?? "unknown"}`);
  console.log("");
  console.log("Description:");
  console.log(t.description || "(empty)");
  console.log("");
  console.log("Current note:");
  console.log(t.current_note || "(none)");
}

const CATEGORIES = ["bug", "feature_request", "improvement"] as const;
const PRIORITIES = ["urgent", "high", "medium", "low", "nice_to_have"] as const;

/** Raises a ticket in the app, the same way the /tickets "New ticket" dialog
 * does. Used when work in a session turns up something worth tracking that
 * nobody has filed yet — the in-app ticket stays the source of truth, so it
 * has to exist here rather than only as a GitHub issue. */
async function create(args: string[]): Promise<void> {
  const flagIndex = args.findIndex((a) => a.startsWith("--"));
  const positional = flagIndex === -1 ? args : args.slice(0, flagIndex);
  const [title, description] = positional;
  if (!title || !description) fail(`create needs a title and a description.\n\n${USAGE}`);

  const readFlag = (name: string, allowed: readonly string[], fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const value = args[i + 1];
    if (!value || !allowed.includes(value)) {
      fail(`--${name} must be one of: ${allowed.join(", ")}`);
    }
    return value;
  };
  const category = readFlag("category", CATEGORIES, "improvement");
  const priority = readFlag("priority", PRIORITIES, "medium");

  const profileId = await fetchDevProfileId();
  const { data, error } = await supabase
    .from("tickets")
    .insert({ title, description, category, priority, status: "open", created_by: profileId })
    .select("id")
    .single();
  if (error) fail(`could not create the ticket: ${error.message}`);
  console.log(`Created ticket #${(data as { id: number }).id}: ${title}`);
}

/** Rewrites a ticket's description in place, for fixing up wording after the
 * fact without opening the app. Title, status and priority are untouched. */
async function describe(id: number, text: string | undefined): Promise<void> {
  if (!text) fail(`missing description text.\n\n${USAGE}`);
  await fetchTicket(id);
  const { error } = await supabase
    .from("tickets")
    .update({ description: text, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) fail(`could not update ticket ${id}: ${error.message}`);
  console.log(`Rewrote the description on ticket ${id}.`);
}

async function start(id: number, rest: string[]): Promise<void> {
  const flagIndex = rest.indexOf("--issue");
  if (flagIndex === -1) fail(`missing --issue.\n\n${USAGE}`);
  const issueRaw = rest[flagIndex + 1];
  const issue = Number(issueRaw);
  if (!issueRaw || !Number.isInteger(issue) || issue <= 0) {
    fail(`"${issueRaw ?? ""}" is not a valid GitHub issue number (expected a positive integer).`);
  }

  await fetchTicket(id);
  const { error } = await supabase
    .from("tickets")
    .update({ status: "in_progress", github_issue: issue, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) fail(`could not update ticket ${id}: ${error.message}`);
  console.log(`Ticket ${id} is now in_progress, linked to GitHub issue #${issue}.`);
}

async function note(id: number, text: string | undefined): Promise<void> {
  if (!text) fail(`missing note text.\n\n${USAGE}`);
  const t = await fetchTicket(id);
  if (t.github_issue === null) {
    fail(`ticket ${id} has no GitHub issue yet — run \`npx tsx scripts/ticket.ts start ${id} --issue <i>\` first.`);
  }
  runGh(["issue", "comment", String(t.github_issue), "--body", text]);
  console.log(`Posted a comment on issue #${t.github_issue}.`);
}

async function done(id: number, text: string | undefined): Promise<void> {
  if (!text) fail(`missing closing note.\n\n${USAGE}`);
  await fetchTicket(id);
  const profileId = await fetchDevProfileId();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("tickets")
    .update({
      status: "done",
      current_note: text,
      note_updated_by: profileId,
      note_updated_at: now,
      updated_at: now,
    })
    .eq("id", id);
  if (error) fail(`could not update ticket ${id}: ${error.message}`);
  console.log(`Ticket ${id} is done, with the closing note saved.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) fail(`missing subcommand.\n\n${USAGE}`);

  if (
    command !== "show" && command !== "start" && command !== "note" &&
    command !== "done" && command !== "create" && command !== "describe"
  ) {
    fail(`unknown subcommand "${command}".\n\n${USAGE}`);
  }

  // `create` is the one subcommand not addressed by ticket number.
  if (command === "create") return create(args);

  const id = parseTicketNumber(args[0]);
  switch (command) {
    case "show":
      return show(id);
    case "start":
      return start(id, args.slice(1));
    case "note":
      return note(id, args[1]);
    case "done":
      return done(id, args[1]);
    case "describe":
      return describe(id, args[1]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
