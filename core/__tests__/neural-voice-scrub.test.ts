/**
 * What the neural voice hands the renderer (status, install, speak) never carries a path of this PC: the pip and
 * edge-tts stderr, the worker's own reason and the Python path are scrubbed before they leave the module (F15).
 * The Python is a small Node script that fails on purpose with a profile path in its stderr.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const neuralPath = path.join(root, "electron", "neural-voice.cjs");
const pythonPath = path.join(root, "electron", "python.cjs");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const PROFILE = "C:\\Users\\jane.roe\\AppData\\Local\\Programs\\Python\\python.exe";
const SCRIPT = `
process.stderr.write("ERROR: cannot write C:\\\\Users\\\\jane.roe\\\\AppData\\\\x.whl (file:///C:/Users/jane.roe/y) done");
process.exit(1);
`;

let dir = "";
let neural: {
  install: () => Promise<{ ok: boolean; error?: string }>;
  status: (force?: boolean) => Promise<{ python?: string; reason?: string }>;
  shutdown: () => void;
};
const realResolve = require_(pythonPath).resolvePython;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-neural-scrub-"));
  const script = path.join(dir, "fail.cjs");
  writeFileSync(script, SCRIPT);
  require_(pythonPath).resolvePython = async () => ({ exe: process.execPath, prefix: [script] });
  delete require_.cache[neuralPath];
  neural = require_(neuralPath);
});

afterEach(() => {
  neural.shutdown();
  require_(pythonPath).resolvePython = realResolve;
  delete require_.cache[neuralPath];
  rmSync(dir, { recursive: true, force: true });
});

describe("the neural voice answers carry no path of this PC", () => {
  it("a failed install answers the pip stderr with the profile path scrubbed", async () => {
    const out = await neural.install();
    expect(out.ok).toBe(false);
    expect(out.error).toContain("cannot write");
    expect(out.error).not.toMatch(/jane\.roe|AppData|C:\\|C:\//);
    expect(out.error).toContain("done");
  });

  it("the status reports the Python path scrubbed", async () => {
    const out = await neural.status(true);
    expect(out.python).toBeTypeOf("string");
    expect(String(out.python)).not.toContain(path.dirname(process.execPath));
    expect(JSON.stringify(out)).not.toMatch(/jane\.roe/);
  });

  it("the edge-tts, SAPI and worker reason sites all go through the scrubber", () => {
    const source = read("electron/neural-voice.cjs");
    expect(source).toContain('require("./path-scrub.cjs")');
    expect(source).toMatch(
      /reason: scrubPaths\(result\.stderr \|\| "edge-tts produced no audio"\)\.slice\(-400\)/,
    );
    expect(source).toMatch(
      /reason: scrubPaths\(result\.error \|\| "sapi wrote no audio"\)\.slice\(0, 240\)/,
    );
    expect(source).toMatch(
      /error: scrubPaths\(result\.stderr \|\| "pip install edge-tts failed"\)\.slice\(-600\)/,
    );
  });

  it("a worker's own reason and error message are scrubbed too", () => {
    const { replyReason } = neural as unknown as {
      replyReason: (answered: unknown, fallback: string) => string;
    };
    for (const answered of [
      { reason: `no model at ${PROFILE} here` },
      { error: `no model at ${PROFILE} here` },
      { error: { message: `no model at ${PROFILE} here` } },
    ]) {
      const out = replyReason(answered, "fallback");
      expect(out).toContain("no model at");
      expect(out).not.toMatch(/jane\.roe|AppData/);
    }
    expect(replyReason(null, "fallback")).toBe("fallback");
  });
});
