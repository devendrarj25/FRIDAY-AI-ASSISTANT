import { createRequire } from "node:module";
import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    // medium and large-v3 are part of setup; large-v3-turbo is fetched from inside FRIDAY.
    const big = rows.find((r) => r.name === "big speech sizes in the plan")?.detail ?? "";
    expect(big).toContain("stt-medium");
    expect(big).toContain("stt-large-v3");
    expect(big).not.toContain("turbo");
    expect(rows.some((r) => r.layer === "speech" && r.name.startsWith("kernel/stt.py"))).toBe(true);
  });

  it("lists the two optional Hindi kernel files as passing kernel rows", () => {
    for (const file of ["kernel/hindi_punct.py", "kernel/tts_hindi_light.py"]) {
      const row = rows.find((r) => r.layer === "kernel" && r.name === file);
      expect(row?.state, file).toBe("PASS");
    }
  });

  it("checks what is on disk only when a folder is given", () => {
    expect(rows.some((r) => r.layer === "disk")).toBe(false);
    const withRoot: Row[] = stack.inventory({
      root: path.join(import.meta.dirname, "no-such-friday-folder"),
    });
    const disk = withRoot.filter((r) => r.layer === "disk");
    expect(disk.length).toBeGreaterThan(0);
    // Nothing is there, and it says so: what setup always fetches fails, what it may skip is information.
    expect(disk.every((r) => r.state === "FAIL" || r.state === "INFO")).toBe(true);
    const failing = disk.filter((r) => r.state === "FAIL").map((r) => r.name);
    for (const name of ["stt-small", "supertonic-3", "hindi-ear", "hindi-punct", "ollama-setup"]) {
      expect(failing).toContain(name);
    }
    // Optional helpers have a fallback (energy VAD, silence timer), so a missing file is information only.
    for (const name of ["silero-vad", "smart-turn"]) {
      expect(disk.find((r) => r.name === name)?.state).toBe("INFO");
    }
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

describe("the voice stack does not ask for the Ollama installer when Ollama is installed", () => {
  it("passes the installer row when Ollama is on the PC and fails it when neither is there", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "../../scripts/voice-stack.cjs"),
      "utf8",
    );
    expect(source).toContain("prefetch.findOllama()");
    expect(source).toContain('job.kind === "installer" && !here && ollamaHere');
    expect(source).toContain("so its installer was not needed");
  });
});

describe("a Hindi pin that names a revision and a SHA-256 per file counts as verified", () => {
  const rev = "a".repeat(40);
  const sha = "b".repeat(64);
  const repoJob = (repo: string) => ({
    id: "hindi-ear",
    kind: "voice-model",
    job: { sources: [{ kind: "hf-repo", repo }] },
  });
  const pins = (pin: unknown) => ({
    pinForRepo: (repo: string) => (repo === "x/ear" ? pin : null),
  });

  it("passes a repository pin with a 40-character revision and a digest for every file", () => {
    const got = stack.verifiedBy(
      repoJob("x/ear"),
      pins({ revision: rev, files: { "a.onnx": { sha256: sha }, "b.txt": { sha256: sha } } }),
    );
    expect(got.ok).toBe(true);
    expect(got.how).toContain("revision aaaaaaaa");
    expect(got.how).toContain("2 files");
  });

  it("keeps failing when the revision, a file digest or the pin itself is missing", () => {
    const files = { "a.onnx": { sha256: sha } };
    expect(stack.verifiedBy(repoJob("x/ear"), pins({ files })).ok).toBe(false);
    expect(stack.verifiedBy(repoJob("x/ear"), pins({ revision: "main", files })).ok).toBe(false);
    expect(
      stack.verifiedBy(
        repoJob("x/ear"),
        pins({ revision: rev, files: { ...files, "b.txt": { bytes: 3 } } }),
      ).ok,
    ).toBe(false);
    expect(stack.verifiedBy(repoJob("x/ear"), pins({ revision: rev, files: {} })).ok).toBe(false);
    expect(stack.verifiedBy(repoJob("x/unknown"), pins({ revision: rev, files })).ok).toBe(false);
    expect(
      stack.verifiedBy({ id: "q", kind: "voice-model", job: { sources: [] } }, pins(null)).ok,
    ).toBe(false);
  });

  it("still accepts a source digest and the publisher-listing kinds", () => {
    const withDigest = { id: "i", kind: "installer", job: { sources: [{ sha256: sha }] } };
    expect(stack.verifiedBy(withDigest, pins(null)).how).toBe("pinned SHA-256");
    const listed = { id: "s", kind: "stt", job: { sources: [{}] } };
    expect(stack.verifiedBy(listed, pins(null)).how).toContain("publisher's listing");
  });

  it("passes hindi-ear and hindi-punct from the real pins, with no unverified row left", () => {
    const withRoot: Row[] = stack.inventory({
      root: path.join(import.meta.dirname, "no-such-friday-folder"),
    });
    for (const id of ["hindi-ear", "hindi-punct"]) {
      const verdict = withRoot.find((r) => r.layer === "setup" && r.name === `${id} is verified`);
      expect(verdict?.state, id).toBe("PASS");
      expect(verdict?.detail).toMatch(/pinned revision [0-9a-f]{8}/);
    }
    expect(withRoot.filter((r) => /is verified$/.test(r.name) && r.state === "FAIL")).toEqual([]);
  });
});

describe("the voice stack names the active engine and the fallbacks per role", () => {
  const find = (list: Row[], name: string) =>
    list.find((r) => r.layer === "engine" && r.name === name);

  it("reads the chains of the engine registry and lists every role as information", () => {
    const names = rows.filter((r) => r.layer === "engine").map((r) => r.name);
    for (const name of [
      "stt hi",
      "stt en",
      "stt hinglish",
      "tts hi",
      "tts en",
      "vad",
      "turn",
      "denoise",
    ])
      expect(names, name).toContain(name);
    expect(rows.filter((r) => r.layer === "engine").every((r) => r.state === "INFO")).toBe(true);
    expect(find(rows, "stt hi")?.detail).toContain("hindi-ear");
    expect(find(rows, "stt hi")?.detail).toContain("disk state needs --root");
  });

  it("with a folder: the first installed engine is active, the rest installed ones are fallbacks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-stack-"));
    try {
      const pin = require_(path.resolve(import.meta.dirname, "../../electron/voice-pins.cjs")).PINS[
        "OpenVoiceOS/ai4bharat-indicconformer-hi-onnx"
      ];
      const ear = path.join(dir, "models", "hindi-ear");
      mkdirSync(ear, { recursive: true });
      for (const name of Object.keys(pin.files)) writeFileSync(path.join(ear, name), "x");
      const list: Row[] = stack.inventory({ root: dir });
      expect(find(list, "stt hi")?.detail).toMatch(/^active hindi-ear/);
      const empty: Row[] = stack.inventory({ root: path.join(dir, "nothing") });
      expect(find(empty, "stt hi")?.detail).toMatch(/^no listening engine installed/);
      // The built-in voices and detectors need no download, so every role still has an answer.
      expect(find(empty, "tts en")?.detail).toMatch(/^active edge-tts/);
      expect(find(empty, "tts en")?.detail).toContain("sapi");
      expect(find(empty, "vad")?.detail).toMatch(/^active energy-vad/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
