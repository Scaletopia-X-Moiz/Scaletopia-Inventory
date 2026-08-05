"use client";

/** Consumes the `data: <json>\n\n` SSE stream shared by the bulk-run routes
 * (push-to-clay, reverify, reverify-phone, clean-names): fetch → read the
 * response body → split on blank lines → parse each `data: ` frame as JSON →
 * hand it to the caller. Callers discriminate event types themselves (each
 * route's event union differs slightly), so this stays a thin mechanics
 * wrapper rather than a shared event schema.
 *
 * Extracted from PushToClayButton/ReverifyFilteredButton, which had this loop
 * duplicated verbatim — kept close to what those two already did rather than
 * generalizing further. */
export async function runSse<TEvent>(
  input: string,
  init: RequestInit | undefined,
  onEvent: (event: TEvent) => void
): Promise<void> {
  const response = await fetch(input, init);

  if (!response.ok || !response.body) {
    const message = (await response.json().catch(() => null))?.error ?? "Request failed";
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data: ")) continue;
      onEvent(JSON.parse(line.slice("data: ".length)) as TEvent);
    }
  }
}

/** Terminal shape of a background push job, as returned by
 * GET /api/push-jobs/[id] (mirrors lib/data/push-jobs.ts's PushJob for the
 * fields the polling UI needs). */
export interface PolledPushJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "partial" | "canceled";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  failures: { name: string; reason: string }[];
  error: string | null;
}

/** Events emitted by pollJob — deliberately close to the SSE event unions the
 * push buttons already consume (a `progress` event with done/total, a
 * terminal `done`/`error`), so swapping runSse → pollJob in those buttons
 * stays a small diff. */
export type PollJobEvent =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; job: PolledPushJob }
  | { type: "error"; message: string };

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "partial", "canceled"]);

/** Polls GET /api/push-jobs/{jobId} every ~1.5s until the job reaches a
 * terminal status, emitting a `progress` event each poll and a final
 * `done`/`error` event. Replaces the old SSE stream for the push buttons now
 * that pushes run as durable background jobs (issue #120) — progress is read
 * from the persisted job row rather than a live connection, so closing the
 * tab no longer loses visibility. */
export async function pollJob(
  jobId: string,
  onEvent: (event: PollJobEvent) => void,
  intervalMs = 1500
): Promise<void> {
  while (true) {
    const response = await fetch(`/api/push-jobs/${jobId}`, { cache: "no-store" });
    if (!response.ok) {
      const message = (await response.json().catch(() => null))?.error ?? "Failed to read push job status";
      onEvent({ type: "error", message });
      return;
    }

    const job = (await response.json()) as PolledPushJob;

    if (TERMINAL_STATUSES.has(job.status)) {
      if (job.status === "failed" && job.succeeded === 0 && job.error) {
        // A job that failed before pushing anyone surfaces its error like the
        // old terminal `{type: "error"}` SSE frame did.
        onEvent({ type: "error", message: job.error });
        return;
      }
      onEvent({ type: "done", job });
      return;
    }

    onEvent({ type: "progress", done: job.processed, total: job.total });
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
