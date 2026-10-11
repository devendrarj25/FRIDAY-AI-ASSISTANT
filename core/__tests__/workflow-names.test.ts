/**
 * Live product text uses the current workflow names. Historical release-note
 * matchers stay able to read the old names.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const RETIRED = ["Release / Build", "Official Publish", "Test EXE Build", "Test EXE"];

describe("live workflow names", () => {
  it("keeps retired workflow names out of the live UI", () => {
    for (const rel of [
      "src/components/friday/settings/ReleaseControls.tsx",
      "src/lib/friday/catalog.ts",
    ]) {
      const text = read(rel);
      for (const name of RETIRED) {
        expect(text, `${rel} still says ${name}`).not.toContain(name);
      }
      expect(text).toContain("FRIDAY Release");
    }
    expect(read("src/lib/friday/catalog.ts")).toContain("FRIDAY Test Build");
    expect(read("src/components/friday/settings/ReleaseControls.tsx")).toContain(
      "FRIDAY Test Build",
    );
  });

  it("keeps the historical note scrubber able to match the old names", () => {
    const engine = read("scripts/release-engine.cjs");
    expect(engine).toContain("Official Publish has not tagged");
    expect(engine).toContain("Test EXE Build");
    expect(engine).toContain("isPublishedEvidenceLine");
  });
});
