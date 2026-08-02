import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.resolve(__dirname, p), "utf8");

// Ticket 84: "Reverify email button fails silently on API error" — the
// ReverifyEmail click handler must surface both a non-OK HTTP response (4xx/5xx
// from POST /api/*/{id}/reverify) and a network-level failure (fetch() itself
// throwing, e.g. offline/DNS/timeout) as an error toast, not swallow either one.
describe("ReverifyEmail — ticket 84: error surfacing", () => {
  const src = read("./reverify-email.tsx");
  const handlerSrc = src.slice(
    src.indexOf("async function handleReverify"),
    src.indexOf("return (")
  );

  it("wraps the fetch + response handling in a try/catch", () => {
    expect(handlerSrc).toMatch(/try\s*{/);
    expect(handlerSrc).toMatch(/}\s*catch\s*\(/);
  });

  it("the fetch() call site is inside the try block (so a thrown network error is caught, not just a non-OK response)", () => {
    const tryIdx = handlerSrc.indexOf("try {");
    const catchIdx = handlerSrc.indexOf("} catch");
    const fetchIdx = handlerSrc.indexOf("await fetch(");
    expect(tryIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(tryIdx);
    expect(fetchIdx).toBeLessThan(catchIdx);
  });

  it("throws on a non-OK response instead of silently proceeding", () => {
    expect(handlerSrc).toMatch(/if\s*\(\s*!response\.ok\s*\)\s*{\s*throw/);
  });

  it("the catch block calls showToast with type \"error\"", () => {
    const catchBlock = handlerSrc.slice(handlerSrc.indexOf("} catch"));
    expect(catchBlock).toMatch(/showToast\(.*,\s*"error"\);/);
  });

  it("the success path (setStatus/setVerifiedAt + success toast) is unchanged", () => {
    expect(handlerSrc).toContain("setStatus(data.emailStatus)");
    expect(handlerSrc).toMatch(/showToast\(`Email reverified:[^`]*`,\s*"success"\)/);
  });

  it("busy state is always cleared via finally, even on error", () => {
    expect(handlerSrc).toMatch(/finally\s*{\s*setBusy\(false\);/);
  });
});
