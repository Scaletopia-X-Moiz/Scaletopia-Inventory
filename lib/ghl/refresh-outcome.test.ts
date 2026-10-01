import { describe, expect, it } from "vitest";
import { refreshOutcomeToast, type RefreshResult } from "@/lib/ghl/refresh-outcome";

/** What the refresh dialog is allowed to claim after an enqueue.
 *
 * Worth its own file because the failure was silent and green: the button
 * read only `jobIds`/`personCount`/`clientCount`, so a fan-out that dropped
 * four sub-accounts for missing credentials — or dropped every one of them —
 * still showed a success toast, and the people in those sub-accounts were
 * never refreshed while the user believed they had been. */

const name = (id: string) => `client-${id}`;

function result(over: Partial<RefreshResult> = {}): RefreshResult {
  return {
    jobIds: ["j1"],
    clientCount: 1,
    personCount: 12,
    estimatedCalls: 12,
    mode: "ids",
    ...over,
  };
}

describe("refreshOutcomeToast", () => {
  it("reports a clean fan-out as a success", () => {
    const [message, type] = refreshOutcomeToast(result({ jobIds: ["a", "b"], clientCount: 2 }), name);
    expect(type).toBe("success");
    expect(message).toContain("12 people across 2 sub-accounts");
    expect(message).toContain("Push Activity");
  });

  it("never calls zero queued jobs a success, even with a server message", () => {
    const [message, type] = refreshOutcomeToast(
      result({ jobIds: [], clientCount: 0, personCount: 0, estimatedCalls: 0, message: "None of those people have been pushed to a GHL sub-account, so there is nothing to refresh." }),
      name
    );
    // Nothing to do because nothing was ever pushed is INFORMATION, not a
    // failure and not a success — it is also not "Refreshing 0 people across
    // 0 sub-accounts", which is what the old toast said in green.
    expect(type).toBe("info");
    expect(message).not.toContain("Refreshing");
    expect(message).toContain("nothing to refresh");
  });

  it("treats every-sub-account-skipped as a failure and gives the reasons", () => {
    const [message, type] = refreshOutcomeToast(
      result({
        jobIds: [],
        clientCount: 0,
        personCount: 0,
        estimatedCalls: 0,
        skippedClients: [
          { clientId: "1", name: "Bigleap", reason: "Bigleap has no GHL credentials configured" },
          { clientId: "2", name: null, reason: "Client not found" },
        ],
      }),
      name
    );
    expect(type).toBe("error");
    expect(message).toContain("Nothing was refreshed");
    expect(message).toContain("Bigleap has no GHL credentials configured");
    // A skip with no name still has to be identifiable.
    expect(message).toContain("client-2: Client not found");
  });

  it("names the skipped sub-accounts when only some were queued", () => {
    const [message, type] = refreshOutcomeToast(
      result({
        jobIds: ["j1"],
        clientCount: 1,
        personCount: 12,
        estimatedCalls: 12,
        skippedClients: [{ clientId: "9", name: "SeedX", reason: "SeedX has no GHL credentials configured" }],
      }),
      name
    );
    // Partial work is not a green tick: 38 people in four sub-accounts going
    // unrefreshed is the thing the user has to be told.
    expect(type).toBe("error");
    expect(message).toContain("Refreshing 12 people");
    expect(message).toContain("1 sub-account was skipped");
    expect(message).toContain("SeedX");
  });

  it("does not call an all_pushed sum 'people'", () => {
    const [message] = refreshOutcomeToast(
      result({ mode: "all_pushed", jobIds: ["a", "b"], clientCount: 2, personCount: 200, estimatedCalls: 200 }),
      name
    );
    // 200 is two sub-accounts' pushed counts added together; the same 100
    // people in both would read as 200 "people".
    expect(message).toContain("counted once per sub-account");
    expect(message).not.toContain("200 people");
  });
});
