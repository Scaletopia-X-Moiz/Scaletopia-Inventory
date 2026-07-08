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
