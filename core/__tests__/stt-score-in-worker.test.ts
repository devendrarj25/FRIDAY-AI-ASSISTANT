/**
 * The end-of-turn score uses the speech worker that already holds the model; the one-shot process stays the fallback.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const stt = createRequire(import.meta.url)("../../electron/stt.cjs");

/** A worker session as attachWorker builds it, with the child replaced by a recorder. */
function fakeSession(loaded: boolean) {
  const writes: string[] = [];
  const kill = vi.fn();
  return {
    writes,
    kill,
    session: {
      alive: true,
      loaded,
      pending: new Map(),
      child: {
        pid: 4242,
        kill,
        stdin: { destroyed: false, write: (line: string) => writes.push(line) },
      },
    },
  };
}

describe("a score never kills a worker that is still loading", () => {
  afterEach(() => vi.useRealTimers());

  it("returns busy while the first load is in flight, and the load survives past the score deadline", async () => {
    vi.useFakeTimers();
    const { session, writes, kill } = fakeSession(false);
    const load = stt.workerRequest(session, { op: "load", model: "small" }, 180000);
    load.catch(() => {});
    const out = await stt.scoreInWorker("clip.wav", session);
    expect(out).toEqual({ ok: true, ready: false, probability: null, reason: "busy" });
    expect(writes.some((line) => line.includes("score-turn"))).toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(kill).not.toHaveBeenCalled();
    expect(session.pending.size).toBe(1);
  });

  it("returns busy for a loaded worker that still has a request queued (a model reload)", async () => {
    vi.useFakeTimers();
    const { session, writes, kill } = fakeSession(true);
    stt.workerRequest(session, { op: "load", model: "base" }, 180000).catch(() => {});
    const out = await stt.scoreInWorker("clip.wav", session);
    expect(out?.reason).toBe("busy");
    expect(writes.filter((line) => line.includes("score-turn"))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(25000);
    expect(kill).not.toHaveBeenCalled();
  });

  it("scores in the worker when it is loaded and idle", async () => {
    const { session, writes } = fakeSession(true);
    const pending = stt.scoreInWorker("clip.wav", session);
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    const sent = JSON.parse(writes[0] as string);
    expect(sent.op).toBe("score-turn");
    session.pending
      .get(sent.id)
      .resolve({ id: sent.id, ready: true, probability: 0.9, reason: "ok" });
    expect(await pending).toEqual({ ok: true, ready: true, probability: 0.9, reason: "ok" });
  });
});

describe("scoring a turn in the running worker", () => {
  const stt = read("electron/stt.cjs");
  const fn =
    /async function scoreInWorker\(file, session = worker\) \{[\s\S]*?\n\}\n/.exec(stt)?.[0] ?? "";

  it("asks the worker for the score-turn op and never starts a worker just to score", () => {
    expect(fn).toContain('op: "score-turn"');
    expect(fn).toMatch(/if \(!session\?\.alive\) return null;/);
    expect(fn).not.toContain("ensureWorker");
  });

  it("does not queue a score behind a running transcription (a busy worker closes the turn on the plain pause)", () => {
    expect(fn).toMatch(
      /if \(turnGate\.busy\(\) \|\|[^)]*\) \{\s*return \{ ok: true, ready: false, probability: null, reason: "busy" \}/,
    );
  });

  it("sends only to a loaded worker with nothing queued (a score must not sit behind a load and kill it on its 20 s deadline)", () => {
    expect(fn).toMatch(/!session\.loaded \|\| session\.pending\.size > 0/);
  });

  it("falls back to the one-shot process when the worker is down, does not know the op, or fails", () => {
    expect(fn).toContain('parsed.reason === "unknown-op"');
    expect(fn).toMatch(/catch \{\s*return null;/);
    const score = /async function scoreTurn\(req = \{\}\) \{[\s\S]*?\n\}\n/.exec(stt)?.[0] ?? "";
    expect(score.indexOf("scoreInWorker(file)")).toBeGreaterThan(0);
    expect(score.indexOf("scoreInWorker(file)")).toBeLessThan(score.indexOf('"--score"'));
  });

  it("is a request with its own long deadline, so a slow answer is not a hung worker", () => {
    expect(fn).toMatch(/workerRequest\(session, \{ op: "score-turn", audio: file \}, 20000\)/);
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
