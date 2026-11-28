/**
 * The Voice diagnostics actions use the shared Button (ghost, small) with sentence-case labels, so every one has
 * the shared focus ring and hit area instead of a private class.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(__dirname, "../../src/components/friday/VoiceDiagnostics.tsx"),
  "utf8",
);

describe("VoiceDiagnostics buttons", () => {
  it("has no raw button element left", () => {
    expect(source).not.toMatch(/<button[\s>]/);
    expect(source).toMatch(/import \{ Button \} from "@\/components\/ui\/button"/);
  });

  it("every Button is ghost and small", () => {
    const opens = source.match(/<Button\b/g) ?? [];
    const ghost = source.match(/<Button\s+type="button"\s+variant="ghost"\s+size="sm"/g) ?? [];
    expect(opens.length).toBeGreaterThanOrEqual(12);
    expect(ghost.length).toBe(opens.length);
  });

  it("labels are sentence case", () => {
    for (const label of [
      "Mic test",
      "Speak test",
      "Run voice self-test",
      "Refresh speech worker",
      "Refresh this PC",
      "Refresh resources",
      "Recheck wake engine",
      "Fix voice",
      "Reset microphone",
      "Copy diagnostics",
    ]) {
      expect(source, label).toContain(label);
    }
    expect(source).not.toMatch(/uppercase text-accent transition-colors/);
  });
});
