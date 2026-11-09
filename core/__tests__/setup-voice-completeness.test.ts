/**
 * What `npm run setup`, the installer and the build do so that listening and speaking work on the first open.
 * These read the scripts; the Windows jobs run them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");

describe("the installer's runtime repair installs the voice core", () => {
  const repair = read("installer/build/repair-runtime.ps1");

  it("checks faster-whisper, PyAV and edge-tts, not only the kernel imports", () => {
    expect(repair).toContain("function Test-VoiceCore");
    expect(repair).toContain("import faster_whisper, av, edge_tts");
    expect(repair).toContain("function Install-VoiceCore");
  });

  it("installs them into a healthy runtime that an older install left without them", () => {
    const start = repair.indexOf("if (Test-Runtime) {");
    const healthy = repair.slice(start, repair.indexOf("New-Item -ItemType Directory", start));
    expect(healthy).toContain("Install-VoiceCore");
    expect(healthy).toContain("Install-CapabilityExtras");
    expect(healthy.indexOf("Install-VoiceCore")).toBeLessThan(healthy.indexOf("Finish 'ready' 0"));
  });

  it("says so when the voice core is still missing, on a healthy runtime and on a fresh one", () => {
    expect(repair.match(/Finish 'voice-packages-failed' 10/g)?.length).toBe(2);
    expect(repair.trimEnd().endsWith("Finish 'ready' 0")).toBe(true);
  });

  it("keeps the old promises: the same four pip methods, CRLF and plain ASCII", () => {
    expect(repair).toContain("--only-binary=:all:");
    expect(repair).toContain("--index-url");
    expect(repair).toContain("Finish 'requirements-failed' 8");
    expect(repair).toContain("\r\n");
    expect([...Buffer.from(repair)].filter((byte) => byte > 127)).toEqual([]);
  });
});

describe("setup and the packaged build", () => {
  it("setup-python verifies PyAV together with faster-whisper and edge-tts", () => {
    const setup = read("scripts/setup-python.cjs");
    expect(setup).toContain("import faster_whisper, av, edge_tts");
    expect(setup).not.toContain("import faster_whisper, edge_tts");
  });

  it("the build refuses a package without the wake model or the voice kernel files", () => {
    const verify = read("scripts/verify-build.cjs");
    for (const label of [
      "Wake model (friday.onnx)",
      "Speech worker",
      "Voice runtime",
      "Wake scorer",
    ])
      expect(verify, label).toContain(`label: "${label}"`);
    expect(verify).toContain('"wake", "friday.onnx"');
  });

  it("the shipped files those checks name exist in the repository", () => {
    for (const file of [
      "resources/wake/friday.onnx",
      "kernel/stt.py",
      "kernel/voice_runtime.py",
      "kernel/wake_word.py",
    ])
      expect(() => readFileSync(file)).not.toThrow();
  });
});

describe("setup and Doctor run the voice files for real, not only check that they exist", () => {
  const setup = read("scripts/setup-python.cjs");
  const smoke = read("scripts/voice-smoke.cjs");

  it("setup runs the shared voice smoke test after the models are fetched, on Windows only", () => {
    const probe = setup.indexOf("voiceSmokeTest(picked.root)");
    expect(probe).toBeGreaterThan(setup.indexOf("whisper-load-probe.json"));
    expect(setup.indexOf("function fetchModelsAndProbe")).toBeLessThan(probe);
    expect(setup).toMatch(/if \(win && voiceImportable\(\)\) \{\s*fetchModelsAndProbe\(\)/);
    expect(setup).toContain('require("./voice-smoke.cjs").voiceSmoke');
    expect(setup).toContain("incomplete.push(...result.problems)");
  });

  it("Doctor runs it too, and then the whole voice stack with the FRIDAY folder", () => {
    const doctor = read("scripts/doctor.cjs");
    expect(doctor).toContain('node("voice-smoke.cjs")');
    expect(doctor).toContain('"--root"');
    // After the models step, so the files it fetched are the ones that get run.
    expect(doctor.indexOf('run: node("voice-smoke.cjs")')).toBeGreaterThan(
      doctor.indexOf("run: models"),
    );
  });

  it("counts a failed check and a download that did not land as a gap, but not the disk reading", () => {
    expect(smoke).toContain("local-tts|vad-silero|smart-turn");
    expect(smoke).toContain("FAIL\\s+disk");
    expect(smoke).toContain('"--check"');
  });

  it("has Supertonic speak one test line to a temporary file that is removed", () => {
    expect(smoke).toContain('"--speak"');
    expect(smoke).toContain("mkdtempSync");
    expect(smoke).toContain("rmSync(dir");
  });
});

describe("the voice smoke test reads what the voice runtime says", () => {
  const smoke = createRequire(import.meta.url)("../../scripts/voice-smoke.cjs");

  it("keeps a real fault and a download that did not land, and ignores a disk reading and the speaker model", () => {
    expect(
      smoke.problemsIn([
        "PASS boot",
        "FAIL rnnoise pyrnnoise is not installed",
        "FAIL disk unmeasured",
        "OPTIONAL local-tts optional - not installed",
        "OPTIONAL speaker optional - not installed",
        "PASS smart-turn file present",
      ]),
    ).toEqual([
      "voice runtime: rnnoise pyrnnoise is not installed",
      "voice runtime: local-tts optional - not installed",
    ]);
  });

  it("passes when the check is clean and Supertonic wrote audio, and fails when either is not", () => {
    const run = (check: string, spoke: boolean) => (_exe: string, args: string[]) => {
      if (args.includes("--check")) return { status: 0, stdout: check };
      const out = String(args[args.indexOf("--out") + 1]);
      if (spoke) writeFileSync(out, Buffer.alloc(5000));
      return { status: 0, stdout: JSON.stringify({ ok: spoke, reason: spoke ? "" : "no voice" }) };
    };
    const clean = "PASS boot\nPASS vad-silero probability=0.1\nPASS smart-turn file present\n";
    const log = () => {};
    expect(
      smoke.voiceSmoke({ python: "py", fridayRoot: "/r", run: run(clean, true), log }),
    ).toEqual({
      ok: true,
      problems: [],
    });
    const mute = smoke.voiceSmoke({ python: "py", fridayRoot: "/r", run: run(clean, false), log });
    expect(mute.ok).toBe(false);
    expect(mute.problems[0]).toContain("did not speak (no voice)");
    const broken = smoke.voiceSmoke({
      python: "py",
      fridayRoot: "/r",
      run: run("FAIL vad-silero scorer failed\n", true),
      log,
    });
    expect(broken.problems).toEqual(["voice runtime: vad-silero scorer failed"]);
  });
});

describe("voice-stack does not fail a PC for a model setup rightly skipped", () => {
  it("reports a size needing more memory, or an optional one, as information", () => {
    const stack = read("scripts/voice-stack.cjs");
    expect(stack).toContain("job.minRamGb && ramGb < job.minRamGb");
    expect(stack).toContain("job.optional");
  });
});
