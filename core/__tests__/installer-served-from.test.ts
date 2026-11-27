/** Voice rows show which source served the installed files (src/lib/friday/installer-fit.ts `servedLine`). */
import { describe, expect, it } from "vitest";
import { rowView, servedLine } from "../../src/lib/friday/installer-fit";
import { FIXED_NOW, fakeRow } from "./helpers/installer-catalog-fixtures";

describe("servedLine", () => {
  it("words the two known sources on a voice row", () => {
    expect(servedLine({ kind: "voice-model", servedFrom: "FRIDAY release" })).toBe(
      "from the FRIDAY release",
    );
    expect(servedLine({ kind: "voice-model", servedFrom: "official source" })).toBe(
      "from the official source",
    );
  });

  it("is empty when unknown, absent or on another kind", () => {
    expect(servedLine({ kind: "voice-model", servedFrom: null })).toBeNull();
    expect(servedLine({ kind: "voice-model" })).toBeNull();
    expect(servedLine({ kind: "voice-model", servedFrom: "elsewhere" })).toBeNull();
    expect(servedLine({ kind: "tool", servedFrom: "FRIDAY release" })).toBeNull();
  });

  it("reaches the row view", () => {
    const row = fakeRow({ kind: "voice-model", servedFrom: "FRIDAY release" });
    expect(rowView(row, new Map(), FIXED_NOW).servedLine).toBe("from the FRIDAY release");
    expect(rowView(fakeRow(), new Map(), FIXED_NOW).servedLine).toBeNull();
  });
});
