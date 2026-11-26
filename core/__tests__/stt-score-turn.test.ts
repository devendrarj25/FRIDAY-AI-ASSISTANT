/**
 * The end-of-turn score: the clip goes to the warm worker as bytes (no temp file), a cold worker is skipped (no
 * one-shot interpreter), and every one-shot child gets the allowlisted environment. Fake worker, no Python.
 */
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWorker, settle } from "./helpers/fake-stt-worker";

const req = createRequire(import.meta.url);
const stt = req("../../electron/stt.cjs");
const neural = req("../../electron/neural-voice.cjs");
const { childEnv } = req("../../electron/voice-worker.cjs");

const wav = () => {
  const b = Buffer.alloc(44 + 3200);
  b.write("RIFF", 0);
  return new Uint8Array(b);
};

describe("score-turn sends bytes to the warm worker", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => {
    stt.useForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("writes no file and sends the clip inline", async () => {
    const r = installFakeWorker(stt);
    await stt.transcribe({ audioBytes: wav(), localOnly: true });
    r.control.respond = (msg) =>
      msg.op === "score-turn"
        ? { id: msg.id, ok: true, ready: true, probability: 0.9, reason: "ok" }
        : undefined;
    const write = vi.spyOn(fs, "writeFileSync");
    const out = await stt.scoreTurn({ audioBytes: wav(), mime: "audio/wav" });
    expect(out).toMatchObject({ ok: true, ready: true, probability: 0.9 });
    const sent = r.sent("score-turn")[0] as Record<string, unknown>;
    expect(typeof sent["audioB64"]).toBe("string");
    expect(sent["audio"]).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it("a cold worker answers skipped and no one-shot process is spawned", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "{}", stderr: "" }));
    const python = vi.fn(async () => ["python-test", []]);
    stt.useForTests({ run, python });
    const out = await stt.scoreTurn({ audioBytes: wav(), mime: "audio/wav" });
    expect(out).toMatchObject({ ok: true, ready: false, probability: null, skipped: "cold" });
    expect(run).not.toHaveBeenCalled();
    expect(python).not.toHaveBeenCalled();
  });

  it("a reason from the worker never carries a path of this PC", async () => {
    const r = installFakeWorker(stt);
    await stt.transcribe({ audioBytes: wav(), localOnly: true });
    const home = os.homedir();
    r.control.respond = (msg) =>
      msg.op === "score-turn"
        ? { id: msg.id, ok: true, ready: false, probability: null, reason: `bad ${home}/x/y.onnx` }
        : undefined;
    const out = await stt.scoreTurn({ audioBytes: wav(), mime: "audio/wav" });
    expect(out.reason).not.toContain(home);
    expect(out.reason).toContain("<");
  });
});

describe("one-shot children get the allowlisted environment", () => {
  const names = (stdout: string) => Object.keys(JSON.parse(stdout) as object);
  const probe = ["-e", "console.log(JSON.stringify(process.env))"];

  for (const [label, mod] of [
    ["stt", stt],
    ["neural-voice", neural],
  ] as const) {
    it(`${label} run() drops secrets and sets PYTHONUTF8`, async () => {
      vi.stubEnv("OPENAI_API_KEY", "x");
      vi.stubEnv("GITHUB_TOKEN", "y");
      const out = await mod.run(process.execPath, probe, 20000);
      const env = names(out.stdout);
      expect(env.some((n) => /_API_KEY$|TOKEN/i.test(n))).toBe(false);
      expect(JSON.parse(out.stdout).PYTHONUTF8).toBe("1");
      vi.unstubAllEnvs();
    });
  }

  it("childEnv is the shared allowlist", () => {
    const env = childEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k" }, {});
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PYTHONUTF8).toBe("1");
    void settle;
  });
});
