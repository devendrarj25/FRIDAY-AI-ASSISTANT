import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectionHeldIn } from "../../src/lib/friday/chat-level";

const inside = { contains: (n: unknown) => n === "in" };

describe("selection hold while streaming", () => {
  it("holds only for a real selection inside the transcript", () => {
    expect(selectionHeldIn(inside, { isCollapsed: false, anchorNode: "in", focusNode: "in" })).toBe(
      true,
    );
    expect(selectionHeldIn(inside, { isCollapsed: false, anchorNode: "x", focusNode: "in" })).toBe(
      true,
    );
    expect(selectionHeldIn(inside, { isCollapsed: true, anchorNode: "in", focusNode: "in" })).toBe(
      false,
    );
    expect(selectionHeldIn(inside, { isCollapsed: false, anchorNode: "x", focusNode: "y" })).toBe(
      false,
    );
    expect(selectionHeldIn(null, { isCollapsed: false, anchorNode: "in", focusNode: "in" })).toBe(
      false,
    );
    expect(selectionHeldIn(inside, null)).toBe(false);
  });

  it("is used by the transcript and the rail choice is remembered", () => {
    const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
    expect(read("src/components/friday/ChatMessages.tsx")).toContain("selectionHeldIn(");
    const dock = read("src/components/friday/ChatDock.tsx");
    expect(dock).toContain('const RAIL_KEY = "friday.chat.rail"');
    expect(dock).toContain("writeState(RAIL_KEY");
    expect(dock).toContain("readLocalState<boolean>(RAIL_KEY)");
  });
});
