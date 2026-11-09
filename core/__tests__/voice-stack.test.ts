import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const stack = require_(path.resolve(import.meta.dirname, "../../scripts/voice-stack.cjs"));

type Row = { layer: string; name: string; state: "PASS" | "FAIL" | "INFO"; detail: string };
const rows: Row[] = stack.inventory({});

describe("the voice stack is complete and connected (scripts/voice-stack.cjs)", () => {
  it("has no gap: every runner, model, package, router, gate and system row passes", () => {
    const failed = rows.filter((r) => r.state === "FAIL");
    expect(failed, failed.map((r) => `${r.layer}/${r.name}: ${r.detail}`).join("\n")).toEqual([]);
  });

  it("covers every layer of the voice mode", () => {
    const layers = new Set(rows.map((r) => r.layer));
    for (const layer of [
      "package",
      "runner",
      "setup",
      "speech",
      "kernel",
      "ipc",
      "router",
      "gate",
      "system",
    ])
      expect(layers.has(layer), layer).toBe(true);
  });

  it("names the pieces the owner asked for: faster-whisper, llama.cpp, Ollama, the big speech size", () => {
    const has = (name: string) => rows.some((r) => r.name === name && r.state === "PASS");
    expect(has("faster-whisper")).toBe(true);
    expect(has("llamacpp release pin")).toBe(true);
    expect(has("ollama release pin")).toBe(true);
    // llama.cpp is added later from Install Manager, so setup must not plan it.
    expect(has("llamacpp-runtime")).toBe(false);
    expect(rows.find((r) => r.name === "big speech sizes in the plan")?.detail).toContain(
      "stt-medium",
    );
    expect(rows.some((r) => r.layer === "speech" && r.name.startsWith("kernel/stt.py"))).toBe(true);
  });

  it("checks what is on disk only when a folder is given", () => {
    expect(rows.some((r) => r.layer === "disk")).toBe(false);
    const withRoot: Row[] = stack.inventory({
      root: path.join(import.meta.dirname, "no-such-friday-folder"),
    });
    const disk = withRoot.filter((r) => r.layer === "disk");
    expect(disk.length).toBeGreaterThan(0);
    expect(disk.every((r) => r.state === "FAIL")).toBe(true); // nothing is there, and it says so
  });

  it("reads package names from a requirements file and finds a banned one", () => {
    const names = stack.packageNames(
      "# c\nfastapi>=1\nuvicorn[standard]>=2\nfaster_whisper>=1.2 # engine\n\ntorch==2.1\n",
    );
    expect(names).toEqual(["fastapi", "uvicorn", "faster-whisper", "torch"]);
    expect(stack.BANNED_PACKAGES.filter((p: string) => names.includes(p))).toEqual(["torch"]);
    expect(stack.BANNED_PACKAGES).toEqual(
      expect.arrayContaining([
        "torch",
        "vllm",
        "vosk",
        "piper-tts",
        "kokoro-onnx",
        "sherpa-onnx",
        "silero-vad",
      ]),
    );
  });

  it("never reports a real-PC fact as a pass: nothing here claims a microphone, a live account or Windows", () => {
    const text = rows.map((r) => `${r.name} ${r.detail}`).join("\n");
    expect(text).not.toMatch(/live account|real microphone|tested on windows/i);
  });
});
