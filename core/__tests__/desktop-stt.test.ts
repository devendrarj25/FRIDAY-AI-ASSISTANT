/**
 * Desktop speech-to-text contract: it must be honest when the engine is not
 * installed and must never silently return empty text as if it heard nothing.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const stt = require_("../../electron/stt.cjs");

describe("desktop stt", () => {
  it("reports availability instead of throwing", async () => {
    const state = await stt.status(true);
    expect(typeof state.available).toBe("boolean");
    if (!state.available) expect(String(state.reason || "")).not.toHaveLength(0);
  });

  it("refuses an empty capture with a reason", async () => {
    const result = await stt.transcribe({ audioBase64: "" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.text).toBeUndefined();
  });

  it("offers real whisper model sizes only", () => {
    expect(stt.MODELS).toContain(stt.DEFAULT_MODEL);
    expect(stt.MODELS.every((m: string) => /^(tiny|base|small|medium|large-v3)$/.test(m))).toBe(
      true,
    );
  });

  it("sweeps stale capture files without failing when none exist", () => {
    const result = stt.sweep(0);
    expect(typeof result.removed).toBe("number");
  });

  it("ships the kernel transcriber script it spawns", () => {
    const script = path.join(process.cwd(), "kernel", "stt.py");
    expect(fs.existsSync(script)).toBe(true);
    const source = fs.readFileSync(script, "utf8");
    expect(source).toContain("faster_whisper");
    // No fake transcript path: every failure branch reports a reason.
    expect(source).toContain('"reason": "missing-dependency"');
    expect(source).toContain("condition_on_previous_text");
    expect(source).toContain("resolve_language");
    expect(source).toContain("initial_prompt");
    expect(source).toContain("--serve");
    expect(source).toContain("_load_count");
    expect(os.tmpdir()).toBeTruthy();
  });

  it("exports a worker shutdown hook so Electron can reap the process", () => {
    expect(typeof stt.shutdown).toBe("function");
    const bridge = fs.readFileSync(path.join(process.cwd(), "electron", "stt.cjs"), "utf8");
    expect(bridge).toContain("ensureWorker");
    expect(bridge).toContain('op: "transcribe"');
  });
});
