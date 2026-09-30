/** Serializes a thrown value to a human-diagnosable string. An `Error` yields
 * its message; a non-Error object (e.g. the bare {message} shape supabase-js
 * can return on an oversized request, or on a connection-pool timeout) is
 * JSON-stringified rather than String()'d, which would otherwise collapse to
 * the useless "[object Object]" that masked a real failure in a push job's
 * error column.
 *
 * Lifted verbatim out of app/api/internal/push-worker/route.ts, which is now
 * the second place this exact bug has bitten: the GHL activity sync's
 * per-contact failure reasons were logging "[object Object]" for supabase-js
 * errors, hiding a pool-exhaustion failure behind a message that named
 * nothing. A third copy lives in app/api/internal/import-worker/route.ts and
 * should be folded in here too, out of scope for this change. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;

  // Prefer a compact JSON dump — it preserves fields like {message, code} that
  // are the whole point of surfacing a non-Error throw.
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}" && json !== "null") return json;
  } catch {
    // circular / non-serializable — fall through to the field/String path
  }

  // JSON gave us nothing useful (undefined, "{}", empty, or it threw). Try to
  // pull a recognizable diagnostic field off the object before giving up.
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    for (const key of ["message", "code", "error_description", "error", "details"]) {
      const val = rec[key];
      if (typeof val === "string" && val.length > 0) return `${key}: ${val}`;
    }
  }

  const str = String(err);
  // String()'ing a plain object yields the diagnostically worthless
  // "[object Object]" — the exact value that masked a real push failure.
  // Surface the internal tag instead so at least the shape is identifiable.
  if (str === "[object Object]") return `non-Error thrown: ${Object.prototype.toString.call(err)}`;
  return str;
}
