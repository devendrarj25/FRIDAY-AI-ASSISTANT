/** The speaker-model wording matches the pinned file: WeSpeaker ResNet34-LM int8, found first by the kernel. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { waveCapabilityChecks } from "../../src/lib/friday/failure-guard";
import { voiceEngineById } from "../../src/lib/friday/voice-engine/voice-engine-registry";

const pins = readFileSync("electron/voice-pins.cjs", "utf8");
const runtime = readFileSync("kernel/voice_runtime.py", "utf8");

describe("speaker model wording", () => {
  it("the kernel finds the pinned ResNet34-LM file first, then the legacy name", () => {
    expect(pins).toContain("model_int8.onnx");
    expect(runtime).toContain('SPEAKER_PINNED = ("speaker-wespeaker", "onnx", "model_int8.onnx")');
    expect(runtime.indexOf("pinned = voice_root()")).toBeLessThan(
      runtime.indexOf("find_named(SPEAKER_FILE)"),
    );
  });

  it("the Doctor row names the real model and still says a missing file is not a match", () => {
    const row = waveCapabilityChecks({}).find((r) => r.id === "speaker:ecapa")!;
    expect(row.detail).toContain("WeSpeaker ResNet34-LM");
    expect(row.detail).toContain("CC-BY-4.0");
    expect(row.detail).toContain("A missing file is not a match.");
    expect(row.detail).not.toContain("WeSpeaker ECAPA is");
    expect(row.fixable).toBe(false);
    expect(row.optional).toBe(true);
  });

  it("the registry row for the old file name says the pinned model is found first and the old name still works", () => {
    const legacy = voiceEngineById.get("wespeaker-ecapa")!;
    expect(legacy.label).toContain("legacy");
    expect(legacy.blockedBy).toContain("speaker-wespeaker/onnx/model_int8.onnx");
    expect(legacy.blockedBy).toContain("wespeaker-ecapa.onnx");
    expect(legacy.blockedBy).not.toMatch(/^the file wespeaker-ecapa\.onnx has no pinned/);
    expect(legacy.status).toBe("candidate-runtime-missing");
    expect(legacy.blockedBy.length).toBeGreaterThan(30);
    expect(voiceEngineById.get("speaker-wespeaker")!.label).toContain("ResNet34-LM");
  });
});
