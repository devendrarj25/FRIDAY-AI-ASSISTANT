/** A catalogue row derived from an unpublished release asset shows its note and offers no Download. */
import { describe, expect, it } from "vitest";
import { rowActions, rowView } from "../../src/lib/friday/installer-fit";
import { fakeRow } from "./helpers/installer-catalog-fixtures";

const NOTE = "Not published in the FRIDAY release yet.";

describe("needsRelease rows", () => {
  it("shows the note and no Download", () => {
    const row = fakeRow({
      id: "voice:ear",
      kind: "voice-model",
      installed: false,
      needsRelease: true,
      note: NOTE,
    });
    expect(rowView(row, new Map(), 0).noteLine).toBe(NOTE);
    expect(
      rowActions(row, { target: { via: "models", id: "ear" }, busy: false }).install,
    ).toBeNull();
  });
  it("keeps Download and no note for an ordinary row", () => {
    const row = fakeRow({ id: "voice:ear", kind: "voice-model", installed: false });
    expect(rowView(row, new Map(), 0).noteLine).toBeNull();
    expect(
      rowActions(row, { target: { via: "models", id: "ear" }, busy: false }).install,
    ).not.toBeNull();
  });
});
