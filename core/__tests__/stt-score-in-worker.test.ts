/**
 * The end-of-turn score uses the speech worker that already holds the model; the one-shot process stays the fallback.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWorker, settle, STATUS_OK } from "./helpers/fake-stt-worker";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const stt = createRequire(import.meta.url)("../../electron/stt.cjs");

const WAV = new Uint8Array(64);

describe("a score never kills a worker that is still loading", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => {
    stt.useForTests();
    vi.useRealTimers();
  });

  it("returns busy while the first load is in flight, and the load survives past the score deadline", async () => {
    const r = installFakeWorker(stt);
    r.control.respond = (msg) =>
      msg.op === "load"
        ? undefined
        : msg.op === "status"
          ? { id: msg.id, ...STATUS_OK }
          : undefined;
    const turn = stt.transcribe({ audioBytes: WAV, localOnly: true });
    turn.catch(() => {});
    await settle();
    expect(r.sent("load")).toHaveLength(1);
    const out = await stt.scoreInWorker(WAV);
    expect(out).toEqual({ ok: true, ready: false, probability: null, reason: "busy" });
    expect(r.sent("score-turn")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(r.killTree).not.toHaveBeenCalled();
  });

  it("returns busy for a loaded worker that still has a request queued (a model reload)", async () => {
    const r = installFakeWorker(stt);
    await stt.transcribe({ audioBytes: WAV, localOnly: true, model: "small" });
    r.control.respond = (msg) => (msg.op === "load" ? undefined : { id: msg.id, ok: true });
    const reload = stt.transcribe({ audioBytes: WAV, localOnly: true, model: "base" });
    reload.catch(() => {});
    await settle();
    expect(r.sent("load")).toHaveLength(2);
    const out = await stt.scoreInWorker(WAV);
    expect(out?.reason).toBe("busy");
    expect(r.sent("score-turn")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(25000);
    expect(r.killTree).not.toHaveBeenCalled();
  });

  it("scores in the worker when it is loaded and idle", async () => {
    const r = installFakeWorker(stt);
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    r.control.respond = (msg) =>
      msg.op === "score-turn"
        ? { id: msg.id, ready: true, probability: 0.9, reason: "ok" }
        : undefined;
    const out = await stt.scoreInWorker(WAV);
    expect(out).toEqual({ ok: true, ready: true, probability: 0.9, reason: "ok" });
    expect(r.sent("score-turn")[0]).toMatchObject({
      op: "score-turn",
      audioB64: Buffer.from(WAV).toString("base64"),
    });
  });

  it("a status check during the first load starts no probe process and no ping", async () => {
    const r = installFakeWorker(stt);
    const probeJson = JSON.stringify({ ok: true, dependency: "ready", available: true });
    const probe = vi.fn(async () => ({ ok: true, stdout: probeJson, stderr: "" }));
    stt.useForTests({
      spawn: r.spawn,
      killTree: r.killTree,
      python: async () => ["python-test", []],
      run: probe,
      weights: async (wanted: string) => ({ ok: true, dir: `/w/${wanted}`, size: wanted }),
    });
    r.control.respond = (msg) =>
      msg.op === "status"
        ? { id: msg.id, ...STATUS_OK }
        : msg.op === "load"
          ? undefined
          : undefined;
    const turn = stt.transcribe({ audioBytes: WAV, localOnly: true });
    turn.catch(() => {});
    await settle();
    probe.mockClear();
    await stt.status(true, { localOnly: true });
    expect(probe).not.toHaveBeenCalled();
    expect(r.sent("status")).toHaveLength(1);
    expect(r.killTree).not.toHaveBeenCalled();
  });
});

describe("scoring a turn in the running worker", () => {
  const stt = read("electron/stt.cjs");
  const fn =
    /async function scoreInWorker\(clip, session = worker\) \{[\s\S]*?\n\}\n/.exec(stt)?.[0] ?? "";

  it("asks the worker for the score-turn op and never starts a worker just to score", () => {
    expect(fn).toContain('op: "score-turn"');
    expect(fn).toMatch(/if \(!session\?\.alive\) return null;/);
    expect(fn).not.toContain("ensureWorker");
  });

  it("does not queue a score behind a running transcription (a busy worker closes the turn on the plain pause)", () => {
    expect(fn).toMatch(
      /turnGate\.busy\(\) \|\|[\s\S]*?getVoiceWorker\(\)\.status\(\)\.state === "busy"\s*\) \{\s*return \{ ok: true, ready: false, probability: null, reason: "busy" \}/,
    );
  });

  it("sends only to a loaded worker with nothing queued (a score must not sit behind a load and kill it on its 20 s deadline)", () => {
    expect(fn).toMatch(/!session\.loaded \|\|\s*session\.pending\.size > 0/);
    expect(fn).toMatch(/state === "starting"[\s\S]*?reason: "busy"/);
  });

  it("skips a cold worker or an old one that does not know the op: no one-shot process is started", () => {
    expect(fn).toContain('parsed.reason === "unknown-op"');
    expect(fn).toMatch(/catch \{\s*return null;/);
    const score = /async function scoreTurn\(req = \{\}\) \{[\s\S]*?\n\}\n/.exec(stt)?.[0] ?? "";
    expect(score).toContain("scoreInWorker(bytes)");
    expect(score).toContain('skipped: "cold"');
    expect(score).not.toContain('"--score"');
    expect(score).not.toContain("writeFileSync");
  });

  it("is a request with its own long deadline, so a slow answer is not a hung worker", () => {
    expect(fn).toMatch(/workerRequest\(session, \{ op: "score-turn", audioB64 \}, 20000\)/);
  });
});

describe("the warm-up names the listening choice", () => {
  it("sends speechPref with the warm-up decode so the engine this turn will use is the one that wakes", () => {
    const prewarm = read("src/lib/friday/voice-prewarm.ts");
    expect(prewarm).toContain("{ speechPref: voice.recognitionLang }");
    expect(prewarm).toContain("provisional: true");
  });

  it("loads the model and warms it in the worker's load op", () => {
    const worker = read("kernel/stt.py");
    expect(worker).toContain("warm_ms = warm_model(model) if _load_count != before else 0");
  });
});
