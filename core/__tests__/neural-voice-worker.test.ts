/**
 * The speech worker runs on the shared lifecycle module (electron/voice-worker.cjs): a chatty worker cannot stall
 * speech, a hung or dead one is replaced, the deadline follows the text, the model is warmed again after an idle
 * unload, and a failed request reads its reason from the kernel's error envelope. The speaker here is a small Node
 * script that speaks the same one-JSON-line protocol, so nothing needs Python, a model or a speaker.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SPEAKER_HUNG_AFTER_MS,
  STUCK_AFTER_MS,
  superviseVoice,
  type SupervisorInput,
} from "../../src/lib/friday/voice-supervisor";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const neural = require_(path.join(root, "electron", "neural-voice.cjs"));
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const SCRIPT = `
const fs = require("fs");
const log = process.env.FRIDAY_FT_LOG;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (process.env.FRIDAY_FT_NOISE) process.stderr.write("x".repeat(Number(process.env.FRIDAY_FT_NOISE)));
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const r = JSON.parse(line);
  if (log) fs.appendFileSync(log, r.op + "\\n");
  const reply = (extra) => out({ id: r.id, ...extra });
  const later = (extra) => setTimeout(() => reply(extra), Number(process.env.FRIDAY_FT_DELAY || 0));
  if (r.op === "speak-pcm" || r.op === "speak") return later({ ok: true, pcm16: "AAAA", pid: process.pid });
  if (r.op === "echo-shadow") return later({ ok: true, ready: true });
  if (r.op === "warm-up") return reply({ ok: true });
  if (r.op === "status") return reply({ ok: true, tts: { live: true } });
  if (r.op === "cwd") return reply({ ok: true, cwd: process.cwd(), pid: process.pid, utf8: process.env.PYTHONUTF8 });
  if (r.op === "pid") return reply({ ok: true, pid: process.pid });
  if (r.op === "cancel") return reply({ ok: true });
  if (r.op === "die") process.exit(3);
  if (r.op === "fail") return reply({ ok: false, reason: "boom", error: { code: "internal-error", message: "boom message" } });
});
`;

let dir = "";
let py: [string, string[]] = ["", []];
const logLines = () =>
  existsSync(logFile()) ? readFileSync(logFile(), "utf8").trim().split("\n") : [];
const logFile = () => path.join(dir, "ops.log");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return check();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-tts-worker-"));
  const script = path.join(dir, "speaker.cjs");
  writeFileSync(script, SCRIPT);
  py = [process.execPath, [script]];
  process.env["FRIDAY_FT_LOG"] = logFile();
});

afterEach(() => {
  neural.shutdown();
  delete process.env["FRIDAY_FT_LOG"];
  delete process.env["FRIDAY_FT_NOISE"];
  delete process.env["FRIDAY_FT_DELAY"];
  rmSync(dir, { recursive: true, force: true });
});

describe("the speaker is started by the shared lifecycle module", () => {
  it("adopts the module and drops its own spawn, pending map and close handler", () => {
    const source = read("electron/neural-voice.cjs");
    expect(source).toContain('require("./voice-worker.cjs")');
    expect(source).toContain("createVoiceWorker({");
    expect(source).toContain("idleUnloadMs: TTS_IDLE_UNLOAD_MS");
    expect(source).not.toContain("pending: new Map()");
    expect(source).not.toContain('child.on("close"');
    expect(source).not.toMatch(/spawn\(py\[0\]/);
    expect(source).toContain('trackOwned("tts"');
  });

  it("runs the child in the temp folder with UTF-8 forced, not in the program folder", async () => {
    const reply = await neural.speakerRequest(py, { op: "cwd" }, 8000);
    expect(reply.ok).toBe(true);
    expect(path.resolve(reply.cwd)).toBe(path.resolve(require_("node:fs").realpathSync(tmpdir())));
    expect(reply.cwd).not.toContain(root);
    expect(reply.utf8).toBe("1");
  });

  it("drains a chatty stderr, so speech is never held by a full pipe (H4)", async () => {
    process.env["FRIDAY_FT_NOISE"] = String(6_000_000);
    const started = Date.now();
    const reply = await neural.speakerRequest(py, { op: "speak-pcm", text: "hello" }, 20000);
    expect(reply?.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(15000);
  });

  it("answers a failed request with the reply envelope instead of null", async () => {
    const reply = await neural.speakerRequest(py, { op: "fail" }, 8000);
    expect(reply).toMatchObject({ ok: false, reason: "boom", error: { code: "internal-error" } });
  });

  it("starts a fresh speaker after one died on its own, and says so in the health view (H10)", async () => {
    const first = await neural.speakerRequest(py, { op: "pid" }, 8000);
    expect(await neural.speakerRequest(py, { op: "die" }, 8000)).toBeNull();
    expect(await until(() => neural.speakerHealth().state !== "ready")).toBe(true);
    const second = await neural.speakerRequest(py, { op: "pid" }, 8000);
    expect(second.pid).not.toBe(first.pid);
    expect(neural.speakerHealth().lastExit).toMatchObject({ code: 3 });
  });

  it("kills a hung speaker at its deadline so the next clause starts a new one (H9)", async () => {
    const first = await neural.speakerRequest(py, { op: "pid" }, 8000);
    expect(await neural.speakerRequest(py, { op: "hang" }, 400)).toBeNull();
    expect(await until(() => !alive(first.pid))).toBe(true);
    const next = await neural.speakerRequest(py, { op: "pid" }, 8000);
    expect(next.pid).not.toBe(first.pid);
  });

  it("caps a speak's deadline at the caller's timeout", async () => {
    process.env["FRIDAY_FT_DELAY"] = "3000";
    const started = Date.now();
    const reply = await neural.speakerRequest(py, { op: "speak-pcm", text: "slow" }, 500);
    expect(reply).toBeNull();
    expect(Date.now() - started).toBeLessThan(2800);
  });

  it("stops the speaker on shutdown and on restartSpeaker, and reports whether one was running", async () => {
    const first = await neural.speakerRequest(py, { op: "pid" }, 8000);
    expect(neural.restartSpeaker()).toEqual({ ok: true, restarted: true });
    expect(await until(() => !alive(first.pid))).toBe(true);
    expect(neural.restartSpeaker()).toEqual({ ok: true, restarted: false });
    const next = await neural.speakerRequest(py, { op: "pid" }, 8000);
    expect(next.pid).not.toBe(first.pid);
  });
});

describe("the deadline follows the text", () => {
  it("is about 15 s per 500 characters when warm, never under 8 s", () => {
    expect(neural.speakDeadlineMs(500, true)).toBe(15000);
    expect(neural.speakDeadlineMs(250, true)).toBe(8000);
    expect(neural.speakDeadlineMs(1000, true)).toBe(30000);
    expect(neural.speakDeadlineMs(0, true)).toBe(8000);
    expect(neural.speakDeadlineMs(Number.NaN, true)).toBe(8000);
  });

  it("adds 60 s while the speaker is cold or loading", () => {
    expect(neural.speakDeadlineMs(500, false)).toBe(75000);
    expect(neural.speakDeadlineMs(10, false)).toBe(68000);
    expect(neural.speakDeadlineMs(500, false)).toBeGreaterThan(neural.speakDeadlineMs(500, true));
  });

  it("is no longer the fixed two minutes for a speak", () => {
    const source = read("electron/neural-voice.cjs");
    expect(source).toContain("speakDeadlineMs(");
    expect(source).toContain("softMs: SPEAK_SOFT_MS");
    expect(source).toContain("const SPEAK_SOFT_MS = 8000");
  });
});

describe("a status or an echo check never queues behind a speak", () => {
  it("does not ask a busy speaker for its status, and the speak still finishes", async () => {
    process.env["FRIDAY_FT_DELAY"] = "700";
    const speak = neural.speakerRequest(py, { op: "speak-pcm", text: "one long line" }, 20000);
    expect(await until(() => neural.speakerHealth().state === "busy")).toBe(true);
    const started = Date.now();
    expect(await neural.speakerRequest(py, { op: "status" }, 15000)).toBeNull();
    expect(await neural.speakerRequest(py, { op: "echo-shadow" }, 5000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(400);
    expect((await speak)?.ok).toBe(true);
  });

  it("asks an idle speaker for its status", async () => {
    await neural.speakerRequest(py, { op: "pid" }, 8000);
    const reply = await neural.speakerRequest(py, { op: "status" }, 15000);
    expect(reply).toMatchObject({ ok: true, tts: { live: true } });
  });
});

describe("the model is warmed again after the speaker left memory (H11)", () => {
  it("keeps the idle unload at ten minutes and shows it in the health view", async () => {
    expect(neural.TTS_IDLE_UNLOAD_MS).toBe(10 * 60 * 1000);
    await neural.speakerRequest(py, { op: "pid" }, 8000);
    expect(neural.speakerHealth()).toMatchObject({ role: "tts", idleUnloadMs: 600000 });
  });

  it("runs the warm-up op before the first speak of a fresh speaker", async () => {
    const reply = await neural.speakerRequest(py, { op: "speak-pcm", text: "hello" }, 20000);
    expect(reply?.ok).toBe(true);
    expect(logLines()).toEqual(["warm-up", "speak-pcm"]);
  });

  it("warms the next speaker again after a restart, and not on a second speak of the same one", async () => {
    await neural.speakerRequest(py, { op: "speak-pcm", text: "one" }, 20000);
    await neural.speakerRequest(py, { op: "speak-pcm", text: "two" }, 20000);
    expect(logLines().filter((op) => op === "warm-up")).toHaveLength(1);
    neural.shutdown();
    await neural.speakerRequest(py, { op: "speak-pcm", text: "three" }, 20000);
    expect(logLines().filter((op) => op === "warm-up")).toHaveLength(2);
  });

  it("does not warm a speaker that a status or a cancel started", async () => {
    await neural.speakerRequest(py, { op: "pid" }, 8000);
    expect(logLines()).toEqual(["pid"]);
  });
});

describe("a cancel reaches a running speaker and never starts one", () => {
  it("reports false with no speaker and does not make a process", async () => {
    expect(await neural.cancelPcm({ utt: "w-1" })).toEqual({ ok: true, utt: "w-1", sent: false });
    expect(existsSync(logFile())).toBe(false);
  });

  it("writes the cancel to a running speaker before it returns", async () => {
    await neural.speakerRequest(py, { op: "pid" }, 8000);
    const answer = await neural.cancelPcm({ utt: "w-2" });
    expect(answer).toEqual({ ok: true, utt: "w-2", sent: true });
    expect(await until(() => logLines().includes("cancel"))).toBe(true);
  });
});

describe("a failed request is read from the error envelope", () => {
  const deps = (request: unknown) => ({
    request,
    resolvePy: async () => ["python", []],
    cacheDir: () => dir,
  });

  it("reads error.message when error is an object, for speak-pcm and for a local speak", async () => {
    const failed = { ok: false, error: { code: "internal-error", message: "kernel said no" } };
    expect(
      (
        await neural.speakPcm(
          { text: "hi" },
          deps(async () => failed),
        )
      ).reason,
    ).toBe("kernel said no");
    expect(
      (
        await neural.speakLocal(
          { text: "hi" },
          deps(async () => failed),
        )
      ).reason,
    ).toBe("kernel said no");
  });

  it("still reads a plain string error from an older kernel, and prefers the reason", async () => {
    expect(
      (
        await neural.speakPcm(
          { text: "hi" },
          deps(async () => ({ ok: false, error: "old" })),
        )
      ).reason,
    ).toBe("old");
    const both = { ok: false, reason: "the reason", error: { code: "x", message: "the message" } };
    expect(
      (
        await neural.speakPcm(
          { text: "hi" },
          deps(async () => both),
        )
      ).reason,
    ).toBe("the reason");
  });

  it("keeps the old fallback when the reply says nothing", async () => {
    expect(
      (
        await neural.speakPcm(
          { text: "hi" },
          deps(async () => ({ ok: false })),
        )
      ).reason,
    ).toBe("local neural voice is not installed");
    expect(
      (
        await neural.speakPcm(
          { text: "hi" },
          deps(async () => null),
        )
      ).reason,
    ).toBe("local neural voice is not installed");
  });

  it("reads the failed warm-up reason from the envelope too", async () => {
    neural.resetWarmUp();
    const failed = { ok: false, error: { code: "internal-error", message: "no model" } };
    const answered = await neural.speakPcm(
      { warm: true },
      deps(async () => failed),
    );
    expect(answered).toMatchObject({ ok: false, reason: "no model" });
    neural.resetWarmUp();
  });
});

describe("the Doctor row carries the engine state and the retry time", () => {
  const own = { engine: "friday-voice", own: true, ready: true };

  it("surfaces engineState and retryInS and tells when the next try is", () => {
    const status = neural.normaliseFridayVoiceStatus({
      ...own,
      engineState: "failing",
      retryInS: 42.2,
      reason: "The FRIDAY voice engine failed (2 in a row).",
    });
    expect(status).toMatchObject({ engineState: "failing", retryInS: 43, state: "failing" });
    expect(status.reason).toBe("The FRIDAY voice engine failed (2 in a row). Next try in 43 s.");
  });

  it("does not repeat a retry time the reason already gives, and ignores it when healthy", () => {
    const said = neural.normaliseFridayVoiceStatus({
      ...own,
      engineState: "stopped",
      retryInS: 30,
      reason: "stopped, next try in 30 s.",
    });
    expect(said.reason).toBe("stopped, next try in 30 s.");
    const healthy = neural.normaliseFridayVoiceStatus({
      ...own,
      engineState: "ready",
      retryInS: 9,
    });
    expect(healthy.reason).toBe("");
  });

  it("drops an unknown engine state and a bad retry time, and keeps the old shape without them", () => {
    const odd = neural.normaliseFridayVoiceStatus({
      ...own,
      engineState: "<script>",
      retryInS: "soon",
    });
    expect("engineState" in odd).toBe(false);
    expect("retryInS" in odd).toBe(false);
    expect(Object.keys(neural.normaliseFridayVoiceStatus({ reason: "x" })).sort()).toEqual(
      ["engine", "own", "ready", "reason", "recipeVersion", "sampleRate", "voiceId"].sort(),
    );
  });
});

describe("the supervisor restarts a hung speaker", () => {
  const base: SupervisorInput = {
    mode: "auto",
    paused: false,
    state: "SPEAKING",
    ageMs: (STUCK_AFTER_MS.SPEAKING ?? 0) + 1,
    brainActive: false,
    speechQueued: false,
    speaking: false,
    downloading: false,
  };

  it("restarts the speaker when replies wait and no sound came out for 45 s", () => {
    expect(SPEAKER_HUNG_AFTER_MS).toBe(45_000);
    expect(superviseVoice({ ...base, speechQueued: true, silentMs: 46_000 })).toMatchObject({
      act: true,
      remedy: "restart-tts",
      fault: "tts-engine-fail",
    });
  });

  it("leaves a speaker that is only between clauses, or one nobody measured, alone", () => {
    expect(superviseVoice({ ...base, speechQueued: true, silentMs: 3_000 })).toEqual({
      act: false,
    });
    expect(superviseVoice({ ...base, speechQueued: true })).toEqual({ act: false });
    expect(
      superviseVoice({ ...base, speaking: true, speechQueued: true, silentMs: 99_000 }),
    ).toEqual({ act: false });
  });

  it("still only releases the state when nothing is waiting or playing", () => {
    expect(superviseVoice(base)).toMatchObject({
      act: true,
      remedy: "release",
      fault: "tts-engine-fail",
    });
  });
});
