/**
 * The Hindi ear and the noise cleaner run on FRIDAY's own paths (nemo_ear.py, FRIDAY Denoise), so the installed
 * Python set no longer lists the two third-party packages that used to back them. The kernel still opens them
 * lazily, inside try blocks, when a user installed them by hand; without them nothing is lost.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
const packageLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

describe("own-runner Python dependencies", () => {
  it("neither requirements file installs onnx-asr or pyrnnoise", () => {
    for (const file of ["kernel/requirements.txt", "kernel/requirements-capabilities.txt"]) {
      const names = packageLines(read(file)).map((l) => l.split(/[<>=!~;\s[]/)[0]!.toLowerCase());
      expect(names, file).not.toContain("onnx-asr");
      expect(names, file).not.toContain("pyrnnoise");
    }
  });

  it("keeps the packages that still have a fallback role", () => {
    const names = packageLines(read("kernel/requirements-capabilities.txt")).map((l) =>
      l.split(/[<>=!~;\s[]/)[0]!.toLowerCase(),
    );
    for (const keep of ["moonshine-voice", "supertonic", "onnxruntime", "numpy"])
      expect(names).toContain(keep);
  });

  it("stt.cjs never tries to install them", () => {
    expect(read("electron/stt.cjs")).not.toMatch(/onnx[-_]asr|pyrnnoise/i);
  });

  it("the kernel imports them only lazily inside a try block", () => {
    const ear = read("kernel/hindi_ear.py");
    const at = ear.indexOf("import onnx_asr");
    expect(at).toBeGreaterThan(0);
    expect(ear.slice(Math.max(0, at - 400), at)).toMatch(/\btry:/);
    expect(ear.slice(0, ear.indexOf("def ")).match(/^\s*(import|from) onnx_asr/m)).toBeNull();
    for (const file of ["kernel/voice_runtime.py", "kernel/hindi_ear.py"]) {
      const top = read(file)
        .split(/\r?\n/)
        .filter((l) => /^(import|from) +(pyrnnoise|onnx_asr)\b/.test(l));
      expect(top, file).toEqual([]);
    }
    const rt = read("kernel/voice_runtime.py");
    for (const m of rt.matchAll(/^( +)(?:import pyrnnoise|from pyrnnoise import)/gm)) {
      const before = rt.slice(0, m.index).split(/\r?\n/).reverse();
      expect(before.find((l) => /^\s*(try|def|class)\b/.test(l)) ?? "").toMatch(/^\s*try:/);
    }
  });

  it("Doctor says the own runner answers when onnx-asr is absent", () => {
    expect(read("kernel/voice_runtime.py")).toContain("int8 weights present (own runner)");
  });
});
