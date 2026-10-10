/**
 * A shortened workflow-contract file can still parse and pass npm test.
 * These markers are the later sections. If they disappear, the file was cut.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const file = path.resolve(__dirname, "ci-workflows.test.ts");

describe("workflow contract file stays complete", () => {
  const src = fs.readFileSync(file, "utf8");

  it("still contains the later workflow contracts", () => {
    for (const marker of [
      'describe("workflow inventory"',
      'describe("PR validation"',
      'describe("official release"',
      'describe("safe merge flow"',
      'describe("automatic-health workflows"',
      "Test EXE and Official Publish reuse a fresh green PR Validation",
      "MINGW*|MSYS*|CYGWIN*",
      "indows[Aa]pps",
    ]) {
      expect(src, marker).toContain(marker);
    }
    expect(src.trimEnd().endsWith("});")).toBe(true);
  });
});
