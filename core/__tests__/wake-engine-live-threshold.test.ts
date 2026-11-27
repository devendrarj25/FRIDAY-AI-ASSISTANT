import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const engine = readFileSync("electron/wake-engine.cjs", "utf8");
const kernel = readFileSync("kernel/wake_word.py", "utf8");
const scoreFrames = engine.slice(
  engine.indexOf("async function scoreFrames"),
  engine.indexOf("function shutdown"),
);

describe("live wake frames run at the manifest's evaluated threshold", () => {
  it("scoreFrames sends a threshold only when the caller gave one", () => {
    expect(scoreFrames).not.toMatch(/threshold\s*=\s*0\.5/);
    expect(scoreFrames).toMatch(
      /\.\.\.\(Number\.isFinite\(threshold\) && threshold > 0 \? \{ threshold \} : \{\}\)/,
    );
  });

  it("the kernel resolves a missing request threshold from the manifest and never goes below 0.5", () => {
    expect(kernel).toContain("def live_threshold(");
    expect(kernel).toContain("LIVE_THRESHOLD_DEFAULT = 0.5");
    expect(kernel).toContain("max(LIVE_THRESHOLD_DEFAULT, clamped)");
    expect(kernel).toContain('threshold if req.get("threshold") else None');
  });
});
