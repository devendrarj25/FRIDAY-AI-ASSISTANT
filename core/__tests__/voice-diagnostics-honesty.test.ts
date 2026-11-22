import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { formatVoiceProbeReport, type VoiceProbeCheck } from "../../src/lib/friday/voice-doctor";
import { healFault } from "../../src/lib/friday/voice-heal";
import {
  figureLine,
  LatencyMonitor,
  UNSTAMPED_STAGES,
  unstampedStagesLine,
} from "../../src/lib/friday/voice-engine/latency-monitor";

const verify = createRequire(import.meta.url)("../../electron/voice-verify.cjs") as Record<
  string,
  unknown
>;

describe("an optional part that is not installed is not a fault", () => {
  const optionalRow: VoiceProbeCheck = {
    id: "local-tts",
    label: "local-tts (optional, not installed)",
    ok: false,
    optional: true,
    detail: "not installed; optional, voice works without it",
  };

  it("its row says 'not installed' once, not three times", () => {
    const report = formatVoiceProbeReport([optionalRow]);
    const text = report.diagnostics;
    expect(text.match(/not installed/gi)?.length).toBe(2);
    expect(report.lines).toEqual(["OPTIONAL local-tts"]);
    expect(optionalRow.label.match(/optional/gi)?.length).toBe(1);
  });

  it("the repair that follows a failed self-test is chosen from a real fault, never an optional part", () => {
    // The old code took the first check with ok false, which was an optional part, and its detail text was classed as a
    // fault ("not installed" reads as a missing speech model): that started a speech-model download on every self-test.
    // ...so choosing an optional row would start a repair (the text names a voice or a model), which is why it is skipped.
    expect(healFault("OPTIONAL local-tts optional - not installed")).not.toBe("none");
    const checks: VoiceProbeCheck[] = [
      optionalRow,
      { id: "boot", label: "boot", ok: true, detail: "PASS boot" },
      { id: "rnnoise", label: "rnnoise", ok: false, detail: "FAIL rnnoise denoiser missing" },
    ];
    const failed = formatVoiceProbeReport(checks).checks.find(
      (check) => !check.ok && !check.optional,
    );
    expect(failed?.id).toBe("rnnoise");
    const onlyOptional = formatVoiceProbeReport([optionalRow, checks[1]!]).checks.find(
      (check) => !check.ok && !check.optional,
    );
    expect(onlyOptional).toBeUndefined();
  });

  it("the main-process verifier writes the label once for the runtime's own optional lines", () => {
    expect(typeof verify["verifyVoiceRuntime"]).toBe("function");
    const source = readFileSync(
      join(__dirname, "..", "..", "electron", "voice-verify.cjs"),
      "utf8",
    );
    expect(source).toMatch(/\(optional, not installed\)/);
    expect(source).not.toMatch(/`\$\{rest\} optional - not installed`/);
  });
});

describe("a latency figure whose stage nothing stamps is shown as not used, never as a number", () => {
  it("names every unstamped stage and keeps a measured figure a number", () => {
    for (const stage of UNSTAMPED_STAGES) expect(unstampedStagesLine()).toContain(stage);
    const monitor = new LatencyMonitor();
    monitor.record("endToFirstAudible", 900);
    expect(figureLine("endToFirstAudible", monitor)).toMatch(/^900 ms typical/);
    expect(figureLine("eagerOverlap", monitor)).toBe("not used yet");
  });
});
