import { describe, expect, it } from "vitest";
import { toClientNames } from "./airtable-clients";

const N = "fldD54l4901ERPq05";

describe("toClientNames", () => {
  it("trims, drops blanks, de-dupes case-insensitively and sorts", () => {
    const out = toClientNames([
      { fields: { [N]: "Redo" } },
      { fields: { [N]: " Acceler8 " } },
      { fields: { [N]: "redo" } },
      { fields: { [N]: "" } },
      { fields: {} },
      { fields: { [N]: 5 } },
    ]);
    expect(out).toEqual(["Acceler8", "Redo"]);
  });
});
