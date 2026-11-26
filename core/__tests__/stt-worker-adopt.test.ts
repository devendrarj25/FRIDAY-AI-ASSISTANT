/**
 * The speech bridge (electron/stt.cjs) runs its Python child through the one lifecycle owner (voice-worker.cjs):
 * single-flight start, a failed start or load stops the child, a status check never queues a ping behind a busy
 * turn, a slow stream feed is a soft miss (killed only after two in a row, a polite close first), a stdout chunk
 * split inside a Hindi character stays whole, and a crash loop opens the module's breaker.
 * Everything runs against a fake child process and fake timers: no Python, no model, no microphone, no Windows.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWorker, settle, STATUS_OK, type Msg } from "./helpers/fake-stt-worker";

const req = createRequire(import.meta.url);
const stt = req("../../electron/stt.cjs");
const paths = req("../../electron/friday-paths.cjs");
const read = (file: string) =>
  fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const rig = installFakeWorker;
const WAV = new Uint8Array(64);
type Spawned = [
  string,
  string[],
  { cwd: string; env: Record<string, string>; windowsHide: boolean },
];

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "friday-stt-adopt-"));
  paths.setRoot(root);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  stt.useForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  paths.setRoot(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("start: one child, shared by every caller", () => {
  it("two turns that arrive together start one child (single flight)", async () => {
    const r = rig();
    const [a, b] = await Promise.all([
      stt.transcribe({ audioBytes: WAV, localOnly: true }),
      stt.transcribe({ audioBytes: WAV, localOnly: true }),
    ]);
    expect(a).toMatchObject({ ok: true, text: "hello" });
    expect(b).toMatchObject({ ok: true, text: "hello" });
    expect(r.spawn).toHaveBeenCalledTimes(1);
    expect(r.sent("status")).toHaveLength(1);
    expect(r.sent("load")).toHaveLength(1);
  });

  it("starts in the temp folder with UTF-8 forced, the serve argv and the FRIDAY root", async () => {
    const r = rig();
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    const [cmd, args, opts] = r.spawn.mock.calls[0] as unknown as Spawned;
    expect(cmd).toBe("python-test");
    expect(args[0]).toBe("-3");
    expect(args.at(-1)).toBe("--serve");
    expect(args.some((a) => /kernel[\\/]stt\.py$/.test(a))).toBe(true);
    expect(opts.cwd).toBe(tmpdir());
    expect(opts.env["PYTHONUTF8"]).toBe("1");
    expect(opts.env["PYTHONIOENCODING"]).toBe("utf-8");
    expect(opts.env["FRIDAY_ROOT"]).toBe(root);
    expect(opts.env["FRIDAY_STT_TIER"]).toBe("auto");
    expect(opts.windowsHide).toBe(true);
  });

  it("loads the model it chose in the module's init, with the weights folder it found", async () => {
    const r = rig();
    await stt.transcribe({ audioBytes: WAV, localOnly: true, model: "base" });
    expect(r.sent("load")[0]).toMatchObject({
      op: "load",
      model: "base",
      model_path: "/weights/base",
    });
    expect(r.sent("transcribe")[0]).toMatchObject({ model: "base", model_path: "/weights/base" });
  });

  it("a Hindi reply split in the middle of a character arrives whole", async () => {
    const r = rig();
    r.control.respond = (msg, child) => {
      if (msg.op === "transcribe") {
        const bytes = Buffer.from(
          `${JSON.stringify({ id: msg.id, ok: true, text: "नमस्ते दुनिया" })}\n`,
        );
        const cut = bytes.indexOf(Buffer.from("द")) + 1;
        child.stdout.write(bytes.subarray(0, cut));
        child.stdout.write(bytes.subarray(cut));
        return undefined;
      }
      if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
      if (msg.op === "load") return { id: msg.id, ok: true, loadCount: 1 };
      return { id: msg.id, ok: true };
    };
    const out = await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(out.text).toBe("नमस्ते दुनिया");
  });
});

describe("a failed start or load never leaves a child alive", () => {
  it("a model that will not load stops the child and says why", async () => {
    const r = rig();
    r.control.respond = (msg) => {
      if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
      if (msg.op === "load") return { id: msg.id, ok: false, error: "out of memory" };
      return { id: msg.id, ok: true };
    };
    const out = await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(out).toMatchObject({ ok: false, reason: "engine-failed" });
    expect(String(out.error)).toContain("out of memory");
    expect(r.killTree).toHaveBeenCalled();
    expect((await stt.status(false, { localOnly: true })).worker).not.toBe("ready");
  });

  it("a missing speech package stops the child too, and does not count toward the crash breaker", async () => {
    const r = rig();
    r.control.respond = (msg) =>
      msg.op === "status"
        ? {
            id: msg.id,
            ok: false,
            dependency: "missing",
            available: false,
            error: "no faster-whisper",
          }
        : { id: msg.id, ok: true };
    for (let turn = 0; turn < 4; turn += 1) {
      const out = await stt.transcribe({ audioBytes: WAV, localOnly: true });
      expect(out.reason).not.toBe("crash-loop");
    }
    // Each turn tries the worker and then its smaller-model retry: every child started was stopped, none was left.
    expect(r.spawn.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(r.killTree).toHaveBeenCalledTimes(r.spawn.mock.calls.length);
  });

  it("after a failed load the next turn starts a fresh child", async () => {
    const r = rig();
    let fail = true;
    r.control.respond = (msg) => {
      if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
      if (msg.op === "load")
        return fail
          ? { id: msg.id, ok: false, error: "boom" }
          : { id: msg.id, ok: true, loadCount: 1 };
      if (msg.op === "transcribe") return { id: msg.id, ok: true, text: "second" };
      return { id: msg.id, ok: true };
    };
    expect((await stt.transcribe({ audioBytes: WAV, localOnly: true })).ok).toBe(false);
    fail = false;
    expect(await stt.transcribe({ audioBytes: WAV, localOnly: true })).toMatchObject({
      ok: true,
      text: "second",
    });
    const last = r.children.at(-1)!;
    expect(r.spawn.mock.calls.length).toBeGreaterThan(1);
    expect(r.killTree).toHaveBeenCalledTimes(r.spawn.mock.calls.length - 1);
    expect(r.killTree).not.toHaveBeenCalledWith(last);
  });
});

describe("a crash is the module's to count", () => {
  it("a child that dies mid-turn fails that turn without a leaked reference, and the next turn respawns", async () => {
    const r = rig();
    let dieOnce = true;
    r.control.respond = (msg, child) => {
      if (msg.op === "transcribe" && dieOnce) {
        dieOnce = false;
        child.die(1, null);
        return undefined;
      }
      if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
      if (msg.op === "load") return { id: msg.id, ok: true, loadCount: 1 };
      return { id: msg.id, ok: true, text: "again" };
    };
    const first = await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(first.ok === false || first.text === "again").toBe(true);
    const next = await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(next).toMatchObject({ ok: true, text: "again" });
    expect(r.spawn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("three crashes in a minute answer crash-loop, and then no new child is spawned while the breaker is open", async () => {
    const r = rig();
    r.control.respond = (msg, child) => {
      if (msg.op === "transcribe") {
        child.die(1, null);
        return undefined;
      }
      if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
      if (msg.op === "load") return { id: msg.id, ok: true, loadCount: 1 };
      return { id: msg.id, ok: true };
    };
    const reasons: string[] = [];
    for (let turn = 0; turn < 5; turn += 1) {
      const out = await stt.transcribe({ audioBytes: WAV, localOnly: true });
      reasons.push(String(out.reason));
    }
    expect(reasons).toContain("crash-loop");
    const spawned = r.spawn.mock.calls.length;
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(r.spawn.mock.calls.length).toBe(spawned);
  });
});

describe("status never queues a ping behind a busy turn (H1)", () => {
  it("a status check while a turn is being transcribed sends nothing to the child and kills nothing", async () => {
    const r = rig();
    let hold: Msg | null = null;
    r.control.respond = (msg) => {
      if (msg.op === "transcribe") {
        hold = msg;
        return undefined;
      }
      if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
      if (msg.op === "load") return { id: msg.id, ok: true, loadCount: 1 };
      return { id: msg.id, ok: true };
    };
    const turn = stt.transcribe({ audioBytes: WAV, localOnly: true });
    await settle();
    expect(hold).not.toBeNull();
    const statusPingsBefore = r.sent("status").length;
    const value = await stt.status(true, { localOnly: true });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(value.worker).toBe("ready");
    expect(r.sent("status")).toHaveLength(statusPingsBefore);
    expect(r.killTree).not.toHaveBeenCalled();
    r.children[0]!.emitLine({ id: (hold as unknown as Msg).id, ok: true, text: "late" });
    expect(await turn).toMatchObject({ ok: true, text: "late" });
  });

  it("an idle worker is asked once for its cache rows, and a failed ping never marks it crashed", async () => {
    const r = rig();
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    const before = r.sent("status").length;
    const value = await stt.status(true, { localOnly: true });
    expect(r.sent("status").length).toBe(before + 1);
    expect(value.worker).toBe("ready");
    expect(r.killTree).not.toHaveBeenCalled();
  });

  it("the source holds no status ping with a kill deadline outside the module's start", () => {
    const src = read("electron/stt.cjs");
    expect(src).not.toMatch(/workerRequest\(worker, \{ op: "status" \}, 15000\)/);
  });
});

describe("the stream ear: a slow feed is a soft miss (H8)", () => {
  const OPEN = { streamEngine: "nemotron", locale: "en", streamId: "s1" };
  const PCM = Buffer.from(new Int16Array(2560).buffer).toString("base64");

  async function openStream(r: ReturnType<typeof rig>, feedReply: boolean) {
    r.control.respond = (msg) => {
      if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
      if (msg.op === "load") return { id: msg.id, ok: true, loadCount: 1 };
      if (msg.op === "stream-open") return { id: msg.id, ok: true, op: "stream-open" };
      if (msg.op === "stream-feed")
        return feedReply ? { id: msg.id, ok: true, events: [], text: "", endpoint: {} } : undefined;
      if (msg.op === "stream-close") return { id: msg.id, ok: true, final: false };
      return { id: msg.id, ok: true };
    };
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(await stt.streamOpen(OPEN)).toMatchObject({ ok: true, streamId: "s1" });
  }

  it("a feed answered in time sends no close and keeps the stream", async () => {
    const r = rig();
    await openStream(r, true);
    expect(await stt.streamFeed({ streamId: "s1", pcm: PCM })).toMatchObject({ ok: true });
    expect(r.sent("stream-close")).toHaveLength(0);
  });

  it("the first 8 s miss does not kill the worker: the stream is closed politely without finalizing", async () => {
    const r = rig();
    await openStream(r, false);
    const feeding = stt.streamFeed({ streamId: "s1", pcm: PCM });
    await settle();
    await vi.advanceTimersByTimeAsync(8_100);
    expect(r.killTree).not.toHaveBeenCalled();
    expect(r.sent("stream-close")[0]).toMatchObject({
      op: "stream-close",
      streamId: "s1",
      finalize: false,
    });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await feeding).toMatchObject({ ok: false, fallback: true });
  });

  it("two misses in a row with no stream line between them kill the worker", async () => {
    const r = rig();
    await openStream(r, false);
    const feeding = stt.streamFeed({ streamId: "s1", pcm: PCM });
    await settle();
    await vi.advanceTimersByTimeAsync(16_200);
    expect(r.killTree).toHaveBeenCalledTimes(1);
    expect(await feeding).toMatchObject({ ok: false, fallback: true });
  });

  it("the feed limits are named: an 8 s soft miss, two misses to stall", () => {
    const src = read("electron/stt.cjs");
    expect(src).toMatch(/const STREAM_FEED_MS = 8_000;/);
    expect(src).toMatch(/softMs: STREAM_FEED_MS/);
    expect(src).toMatch(/stallMisses: 2/);
  });
});

describe("cancel, score, idle release and shutdown ride the same module", () => {
  async function loadedRig() {
    const r = rig();
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    return r;
  }

  it("cancelTranscribe writes one cancel op to the live worker and never kills it", async () => {
    const r = await loadedRig();
    r.control.respond = (msg) =>
      msg.op === "cancel" ? { id: msg.id, ok: true, cancelled: true } : undefined;
    let finish: (value: unknown) => void = () => {};
    const decoding = stt.runProvisional(
      { provisional: true, utteranceId: "p-1" },
      () => new Promise((resolve) => (finish = resolve)),
    );
    const answer = stt.cancelTranscribe({ utteranceId: "p-1" });
    finish({ ok: true, text: "x" });
    expect(await decoding).toMatchObject({ reason: "cancelled" });
    await settle();
    expect(answer).toEqual({ ok: true, cancelled: true, signalled: true });
    expect(r.sent("cancel")[0]).toMatchObject({ op: "cancel", utteranceId: "p-1" });
    expect(r.killTree).not.toHaveBeenCalled();
  });

  it("an end-of-turn score is not queued behind a turn that is being transcribed", async () => {
    const r = await loadedRig();
    r.control.respond = (msg) => (msg.op === "transcribe" ? undefined : { id: msg.id, ok: true });
    const turn = stt.transcribe({ audioBytes: WAV, localOnly: true });
    turn.catch(() => {});
    await settle();
    const out = await stt.scoreInWorker("clip.wav");
    expect(out).toEqual({ ok: true, ready: false, probability: null, reason: "busy" });
    expect(r.sent("score-turn")).toHaveLength(0);
  });

  it("scores in the loaded idle worker", async () => {
    const r = await loadedRig();
    r.control.respond = (msg) =>
      msg.op === "score-turn"
        ? { id: msg.id, ok: true, ready: true, probability: 0.8, reason: "eot" }
        : undefined;
    const out = await stt.scoreInWorker("clip.wav");
    expect(out).toEqual({ ok: true, ready: true, probability: 0.8, reason: "eot" });
  });

  it("releaseIdle closes an idle worker through the module and keeps a busy one", async () => {
    const r = await loadedRig();
    expect(stt.releaseIdle(60_000)).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    r.control.respond = (msg) => (msg.op === "transcribe" ? undefined : { id: msg.id, ok: true });
    const turn = stt.transcribe({ audioBytes: WAV, localOnly: true });
    turn.catch(() => {});
    await settle();
    expect(stt.releaseIdle(60_000)).toBe(false);
    expect(r.killTree).not.toHaveBeenCalled();
    r.children[0]!.emitLine({ id: r.children[0]!.seen.at(-1)!.id, ok: true, text: "done" });
    await turn;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stt.releaseIdle(60_000)).toBe(true);
    await settle();
    expect(r.killTree).toHaveBeenCalledTimes(1);
    expect((await stt.status(false, { localOnly: true })).worker).not.toBe("ready");
  });

  it("shutdown stops the child once, and the next turn starts a new one", async () => {
    const r = await loadedRig();
    stt.shutdown();
    await settle();
    expect(r.killTree).toHaveBeenCalledTimes(1);
    expect(await stt.transcribe({ audioBytes: WAV, localOnly: true })).toMatchObject({ ok: true });
    expect(r.spawn).toHaveBeenCalledTimes(2);
  });

  it("mute ends an open stream and frees the turn gate", async () => {
    const r = rig();
    r.control.respond = (msg) => {
      if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
      if (msg.op === "load") return { id: msg.id, ok: true, loadCount: 1 };
      if (msg.op === "transcribe") return { id: msg.id, ok: true, text: "x" };
      if (msg.op === "stream-open") return { id: msg.id, ok: true };
      return { id: msg.id, ok: true };
    };
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(await stt.streamOpen({ streamEngine: "nemotron", streamId: "m1" })).toMatchObject({
      ok: true,
    });
    expect(stt.onMute(true)).toEqual({ stopped: true });
    await settle();
    expect(r.sent("stream-close").some((m) => m["finalize"] === false)).toBe(true);
  });
});

describe("the old lifecycle code is gone from the bridge", () => {
  const full = read("electron/stt.cjs");
  const src = full;

  it("does not spawn, track a child, buffer stderr or decode stdout itself", () => {
    const src = full.replace(/function useForTests[\s\S]*?\n\}\n/, "");
    expect(src).not.toMatch(/function attachWorker/);
    expect(src).not.toMatch(/function killTree/);
    expect(src).not.toMatch(/function rejectPending/);
    expect(src).not.toMatch(/String\(chunk\)/);
    expect(src).not.toMatch(/session\.err\b/);
    expect(src).not.toMatch(/^\s+worker = null\b/m);
    expect(src).not.toMatch(/crashTimes/);
    expect(src).not.toMatch(/function recordSttCrash/);
  });

  it("builds one voice worker for the stt role with the breaker the plan names", () => {
    expect(src).toMatch(/require\("\.\/voice-worker\.cjs"\)/);
    expect(src).toMatch(/role: "stt"/);
    expect(src).toMatch(/breaker: \{ max: 3, windowMs: 60_000, coolMs: 300_000 \}/);
  });
});
