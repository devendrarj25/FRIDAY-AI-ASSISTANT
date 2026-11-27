import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ACK_LINES,
  ACKS_TIMEOUT_MS,
  AckMemory,
  HEAVY_STEPS,
  Prewarm,
  PREWARM_STEPS,
  RETRY_DELAY_MS,
  STEP_TIMEOUT_MS,
  WARM_SPEECH_TEXT,
  lastPrewarmReport,
  notePrewarmReport,
  planSteps,
  prewarmBlock,
  prewarmDoctorRows,
  prewarmLine,
  type PrewarmIO,
  type PrewarmPlan,
  type PrewarmResult,
} from "../../src/lib/friday/voice-engine/prewarm";
import { DEFAULT_PREFERENCES, preferences } from "../../src/lib/friday/preferences";
import {
  ACK_CATALOGUE,
  ackPrewarmLines,
  isYesLike,
} from "../../src/lib/friday/voice-engine/instant-ack";

vi.mock("../../src/lib/friday/kernel-api", () => ({
  kernelApi: { status: vi.fn(async () => ({ connected: true })) },
}));

const root = resolve(import.meta.dirname, "../..");
const source = (rel: string) => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const PLAN: PrewarmPlan = {
  enabled: true,
  mode: "auto",
  micOpen: true,
  held: false,
  engines: { stt: true, brain: true, tts: true, turn: true },
  light: false,
};

/** Fake engines and a fake clock: nothing waits for real time. */
function rig(over: Partial<PrewarmIO> = {}) {
  const calls: string[] = [];
  const slept: number[] = [];
  const timers: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  let now = 10_000;
  const ok = (name: string, cost: number) => async (): Promise<PrewarmResult> => {
    calls.push(name);
    now += cost;
    return { ok: true };
  };
  const io: PrewarmIO = {
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    after: (ms, fire) => {
      const timer = { ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    warmListening: ok("stt", 300),
    warmBrain: ok("brain", 20),
    warmSpeech: async (text) => {
      calls.push(`tts:${text}`);
      now += 400;
      return { ok: true };
    },
    warmTurn: ok("turn", 150),
    makeAck: async (line) => {
      calls.push(`ack:${line.id}`);
      now += 100;
      return { ok: true };
    },
    ...over,
  };
  return { io, calls, slept, timers, clock: () => now };
}

describe("when a pass may start", () => {
  it("never before the microphone is open, never outside Auto, never while held or turned off", async () => {
    const cases: Array<[Partial<PrewarmPlan>, RegExp]> = [
      [{ micOpen: false }, /microphone is not open/],
      [{ mode: "manual" }, /only Auto/],
      [{ mode: "chat" }, /only Auto/],
      [{ held: true }, /muted, paused or stopped/],
      [{ enabled: false }, /turned off/],
    ];
    for (const [change, why] of cases) {
      const r = rig();
      const report = await new Prewarm(r.io).run({ ...PLAN, ...change });
      expect(r.calls).toEqual([]);
      expect(r.timers).toEqual([]);
      expect(report.outcomes.map((o) => o.step)).toEqual([...PREWARM_STEPS]);
      for (const outcome of report.outcomes) {
        expect(outcome.state).toBe("skipped");
        expect(outcome.reason).toMatch(why);
      }
    }
    expect(prewarmBlock(PLAN)).toBeNull();
  });
});

describe("the pass", () => {
  it("runs each selected engine once in a fixed order and stamps every step", async () => {
    const r = rig();
    const stamps: string[] = [];
    const report = await new Prewarm(r.io, {
      onStep: (o) => stamps.push(`${o.step}:${o.state}:${o.ms}`),
    }).run(PLAN);
    expect(r.calls).toEqual([
      "stt",
      "brain",
      `tts:${WARM_SPEECH_TEXT}`,
      "turn",
      ...ACK_LINES.map((line) => `ack:${line.id}`),
    ]);
    expect(stamps).toEqual([
      "stt:done:300",
      "brain:done:20",
      "tts:done:400",
      "turn:done:150",
      `acks:done:${ACK_LINES.length * 100}`,
    ]);
    expect(report.ms).toBe(300 + 20 + 400 + 150 + ACK_LINES.length * 100);
    expect(report.outcomes.every((o) => o.attempts === 1)).toBe(true);
    // The warm-up phrase is three words and every timer of the pass was cancelled when its step ended.
    expect(WARM_SPEECH_TEXT.split(/\s+/)).toHaveLength(3);
    expect(r.timers.every((t) => t.cancelled)).toBe(true);
    expect(r.timers.map((t) => t.ms)).toEqual([
      STEP_TIMEOUT_MS,
      STEP_TIMEOUT_MS,
      STEP_TIMEOUT_MS,
      STEP_TIMEOUT_MS,
      ACKS_TIMEOUT_MS,
    ]);
  });

  it("runs only the engines the saved settings select", async () => {
    const r = rig();
    const report = await new Prewarm(r.io).run({
      ...PLAN,
      engines: { stt: true, brain: false, tts: false, turn: false },
    });
    expect(r.calls).toEqual(["stt"]);
    const byStep = Object.fromEntries(report.outcomes.map((o) => [o.step, o]));
    expect(byStep["stt"]?.state).toBe("done");
    for (const step of ["brain", "tts", "turn", "acks"] as const) {
      expect(byStep[step]?.state).toBe("skipped");
      expect(byStep[step]?.reason).toMatch(/not selected/);
    }
  });

  it("skips the heavy steps on the Lite profile or battery and keeps the light one", async () => {
    const r = rig();
    const report = await new Prewarm(r.io).run({ ...PLAN, light: true });
    expect(r.calls).toEqual(["brain"]);
    for (const outcome of report.outcomes) {
      if (HEAVY_STEPS.includes(outcome.step)) {
        expect(outcome.state).toBe("skipped");
        expect(outcome.reason).toMatch(/Lite profile or battery/);
      }
    }
    expect(planSteps({ ...PLAN, light: true }).filter((s) => !s.skip)).toEqual([
      { step: "brain", skip: "" },
    ]);
  });

  it("retries a failing step once after a short wait, then goes on with the rest", async () => {
    let attempts = 0;
    const r = rig({
      warmSpeech: async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, reason: "worker is starting" } : { ok: true };
      },
      warmTurn: async () => {
        throw new Error("onnx exploded");
      },
    });
    const report = await new Prewarm(r.io).run(PLAN);
    const byStep = Object.fromEntries(report.outcomes.map((o) => [o.step, o]));
    expect(byStep["tts"]).toMatchObject({ state: "done", attempts: 2 });
    expect(byStep["turn"]).toMatchObject({ state: "failed", attempts: 2, reason: "onnx exploded" });
    expect(r.slept).toEqual([RETRY_DELAY_MS, RETRY_DELAY_MS]);
    expect(byStep["acks"]?.state).toBe("done");
  });

  it("a step that never answers times out, is retried, and never blocks the pass", async () => {
    let first = true;
    const r = rig({
      warmListening: () =>
        first
          ? ((first = false), new Promise<PrewarmResult>(() => undefined))
          : Promise.resolve({ ok: true }),
    });
    const pass = new Prewarm(r.io).run(PLAN);
    await flush();
    expect(r.timers).toHaveLength(1);
    r.timers[0]?.fire();
    const report = await pass;
    expect(report.outcomes[0]).toMatchObject({ step: "stt", state: "done", attempts: 2 });
    expect(report.outcomes.slice(1).every((o) => o.state === "done")).toBe(true);
  });

  it("two timeouts in a row are one failed step with the reason, not an error", async () => {
    const r = rig({ warmBrain: () => new Promise<PrewarmResult>(() => undefined) });
    const pass = new Prewarm(r.io).run(PLAN);
    for (let i = 0; i < 2; i += 1) {
      await flush();
      r.timers.filter((t) => !t.cancelled).forEach((t) => t.fire());
    }
    const report = await pass;
    expect(report.outcomes.find((o) => o.step === "brain")).toMatchObject({
      state: "failed",
      attempts: 2,
      reason: "timed out",
    });
  });

  it("an optional model that is not installed is skipped, not failed", async () => {
    const r = rig({
      warmTurn: async () => ({ ok: true, skipped: true, reason: "smart-turn file absent" }),
    });
    const report = await new Prewarm(r.io).run(PLAN);
    expect(report.outcomes.find((o) => o.step === "turn")).toMatchObject({
      state: "skipped",
      reason: "smart-turn file absent",
    });
    expect(prewarmDoctorRows(report)).toEqual([]);
  });

  it("a failing stamp hook cannot stop the pass, and a second call joins the running pass", async () => {
    const r = rig();
    const pass = new Prewarm(r.io, {
      onStep: () => {
        throw new Error("hook");
      },
    });
    const first = pass.run(PLAN);
    expect(pass.isRunning()).toBe(true);
    expect(pass.run(PLAN)).toBe(first);
    const report = await first;
    expect(report.outcomes).toHaveLength(PREWARM_STEPS.length);
    expect(pass.isRunning()).toBe(false);
    expect(pass.last()).toBe(report);
  });
});

describe("cancel (mute, pause, Stop everything)", () => {
  it("stops at the next step, makes no acknowledgement line and tells the owner of what it made", async () => {
    let cancelled = 0;
    const held: { pass?: Prewarm } = {};
    const r = rig({
      warmSpeech: async () => {
        // The owner pauses while the voice is warming.
        held.pass?.cancel();
        return { ok: true };
      },
    });
    const pass = new Prewarm(r.io, { onCancel: () => (cancelled += 1) });
    held.pass = pass;
    const report = await pass.run(PLAN);
    expect(cancelled).toBe(1);
    expect(r.calls).toEqual(["stt", "brain"]);
    const byStep = Object.fromEntries(report.outcomes.map((o) => [o.step, o.state]));
    expect(byStep).toEqual({
      stt: "done",
      brain: "done",
      tts: "cancelled",
      turn: "cancelled",
      acks: "cancelled",
    });
    pass.cancel();
    expect(cancelled).toBe(1);
  });

  it("stops between two acknowledgement lines", async () => {
    const held: { pass?: Prewarm } = {};
    const made: string[] = [];
    const r = rig({
      makeAck: async (line) => {
        made.push(line.id);
        if (made.length === 2) held.pass?.cancel();
        return { ok: true };
      },
    });
    const pass = new Prewarm(r.io);
    held.pass = pass;
    const report = await pass.run(PLAN);
    expect(made).toHaveLength(2);
    expect(report.outcomes.find((o) => o.step === "acks")?.state).toBe("cancelled");
  });
});

describe("Voice Doctor and the line", () => {
  it("a failed step becomes a Warning row, never an error, and nothing else does", async () => {
    const r = rig({
      warmBrain: async () => ({ ok: false, reason: "kernel is not running" }),
      warmTurn: async () => ({ ok: true, skipped: true, reason: "absent" }),
    });
    const report = await new Prewarm(r.io).run(PLAN);
    const rows = prewarmDoctorRows(report);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "voice:prewarm-brain",
      group: "Voice",
      status: "Warning",
      fixable: false,
    });
    expect(rows[0]?.detail).toContain("kernel is not running");
    expect(prewarmLine(report)).toMatch(
      /^prewarm \d+ ms: stt 300 ms, brain failed \(kernel is not running\), tts 400 ms, turn skipped, acks \d+ ms$/,
    );
    notePrewarmReport(report);
    expect(lastPrewarmReport()).toBe(report);
    expect(prewarmDoctorRows()).toHaveLength(1);
    notePrewarmReport(null);
    expect(prewarmDoctorRows()).toEqual([]);
  });

  it("is added to the layer rows of Voice Doctor only when something failed", async () => {
    const { voiceLayerChecks } = await import("../../src/lib/friday/voice-doctor");
    notePrewarmReport(null);
    const base = voiceLayerChecks({}).length;
    const r = rig({ warmSpeech: async () => ({ ok: false, reason: "no samples" }) });
    notePrewarmReport(await new Prewarm(r.io).run(PLAN));
    const rows = voiceLayerChecks({});
    expect(rows).toHaveLength(base + 1);
    expect(rows.at(-1)).toMatchObject({ id: "voice:prewarm-tts", status: "Warning" });
    notePrewarmReport(null);
  });
});

describe("acknowledgement memory", () => {
  it("keeps short lines in memory and forgets them on clear", () => {
    const memory = new AckMemory<string>();
    memory.put("a", "x");
    memory.put("b", "y");
    expect(memory.get("a")).toBe("x");
    expect(memory.ids()).toEqual(["a", "b"]);
    memory.clear();
    expect(memory.get("a")).toBeUndefined();
    expect(ACK_LINES.some((line) => line.lang === "hi")).toBe(true);
    expect(ACK_LINES.some((line) => line.lang === "en")).toBe(true);
    // The lines are the instant-acknowledgement catalogue and nothing else: short, never a yes-word.
    expect(ACK_LINES.map((line) => line.id)).toEqual(ACK_CATALOGUE.map((entry) => entry.id));
    expect(ACK_LINES).toEqual(ackPrewarmLines());
    expect(ACK_LINES.every((line) => line.text.split(/\s+/).length <= 4)).toBe(true);
    expect(ACK_LINES.every((line) => !isYesLike(line.text))).toBe(true);
  });
});

describe("the real engines behind the pass (fake bridge, no device)", () => {
  type Win = Record<string, unknown>;
  const g = globalThis as unknown as { window?: Win | undefined };
  const saved = g.window;
  let lib: typeof import("../../src/lib/friday/voice-prewarm");
  let sent: Record<string, unknown[]>;

  const bridge = (over: Record<string, unknown> = {}): Win => ({
    friday: {
      sttStatus: async () => ({
        available: true,
        ready: true,
        model: "base",
        engine: "faster-whisper",
      }),
      transcribe: async (req: unknown) => {
        (sent["transcribe"] ??= []).push(req);
        return { ok: true, text: "" };
      },
      scoreTurn: async (req: unknown) => {
        (sent["scoreTurn"] ??= []).push(req);
        return { ok: true, ready: true, probability: 0.9 };
      },
      neuralVoiceStatus: async () => ({ available: true }),
      speakNeuralPcm: async (req: { text: string; lang?: string }) => {
        (sent["speak"] ??= []).push(req);
        return {
          ok: true,
          sampleRate: 44_100,
          pcm: new Uint8Array(new Int16Array(441).fill(1200).buffer),
        };
      },
      ...over,
    },
  });

  beforeEach(async () => {
    sent = {};
    lib = await import("../../src/lib/friday/voice-prewarm");
    lib.cancelPrewarm();
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
  });
  afterEach(() => {
    lib.cancelPrewarm();
    g.window = saved;
    notePrewarmReport(null);
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
  });

  const state = { mode: "auto", micOpen: true, held: false, localVoice: true };
  /** The acknowledgement lines are made only for the owner who turned the instant acknowledgement on. */
  const ackOn = () =>
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, instantAck: true } });

  it("with the instant acknowledgement off (the default) no acknowledgement line is made", async () => {
    expect(DEFAULT_PREFERENCES.voice.instantAck).toBe(false);
    g.window = bridge();
    const report = await lib.startPrewarm(state);
    expect(report.outcomes.map((o) => `${o.step}:${o.state}`)).toEqual([
      "stt:done",
      "brain:done",
      "tts:done",
      "turn:done",
      "acks:skipped",
    ]);
    const calls = (sent["speak"] ?? []) as Array<{ text: string; warm?: boolean }>;
    expect(calls.filter((c) => c.warm === true)).toHaveLength(1); // the engine warm-up, once
    expect(calls.filter((c) => !c.warm)).toHaveLength(1); // only the three-word warm-up phrase
    expect(lib.ackMemory.ids()).toEqual([]);
    expect(lib.readyAckClipIds()).toEqual([]);
  });

  it("is on by default and every call is local: silence, provisional, no microphone", async () => {
    expect(DEFAULT_PREFERENCES.voice.prewarm).toBe(true);
    ackOn();
    g.window = bridge();
    const steps: string[] = [];
    const report = await lib.startPrewarm(state, (o) => steps.push(`${o.step}:${o.state}`));
    expect(steps).toEqual(["stt:done", "brain:done", "tts:done", "turn:done", "acks:done"]);
    expect(report.outcomes.every((o) => o.state === "done")).toBe(true);
    const decode = sent["transcribe"]?.[0] as Record<string, unknown>;
    expect(decode).toMatchObject({ localOnly: true, provisional: true, mime: "audio/wav" });
    expect((decode["audioBytes"] as Uint8Array).length).toBe(44 + 16_000 * 2);
    expect(sent["scoreTurn"]).toHaveLength(1);
    // One three-word warm-up phrase, then the acknowledgement lines; only the lines are kept.
    expect((sent["speak"]?.[0] as { text: string }).text).toBe(WARM_SPEECH_TEXT);
    expect(sent["speak"]).toHaveLength(1 + ACK_LINES.length);
    expect(lib.ackMemory.ids()).toEqual(ACK_LINES.map((line) => line.id));
    expect(lib.readyAckClipIds()).toEqual(ackPrewarmLines().map((line) => line.id));
    expect(lib.ackClipFor("ack-en-1")).toMatchObject({ lang: "en", rate: 44_100 });
    expect(lib.ackClipFor("no-such-line")).toBeUndefined();
    const hi = lib.ackMemory.get("ack-hi-1");
    expect(hi).toMatchObject({ lang: "hi", rate: 44_100 });
    expect(hi?.pcm).toBeInstanceOf(Int16Array);
    expect(sent["speak"]?.some((req) => (req as { lang?: string }).lang === "hi-IN")).toBe(true);
    expect(lastPrewarmReport()).toBe(report);
  });

  it("does nothing when the setting is off, and nothing before the microphone is open", async () => {
    g.window = bridge();
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, prewarm: false } });
    const off = await lib.startPrewarm(state);
    expect(off.outcomes.every((o) => o.state === "skipped")).toBe(true);
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
    const early = await lib.startPrewarm({ ...state, micOpen: false });
    expect(early.outcomes.every((o) => o.state === "skipped")).toBe(true);
    expect(sent).toEqual({});
    expect(lib.ackMemory.ids()).toEqual([]);
  });

  it("makes no voice call when the local voice is not the selected one or replies are off", async () => {
    g.window = bridge();
    await lib.startPrewarm({ ...state, localVoice: false });
    expect(sent["speak"]).toBeUndefined();
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, speakReplies: false } });
    await lib.startPrewarm(state);
    expect(sent["speak"]).toBeUndefined();
    expect(sent["transcribe"]).toHaveLength(2);
  });

  it("a missing optional model is skipped; a voice that is not installed is a failed step, not a throw", async () => {
    ackOn();
    g.window = bridge({
      scoreTurn: async () => ({ ok: true, ready: false, reason: "smart-turn file absent" }),
      neuralVoiceStatus: async () => ({ available: false, reason: "Supertonic is not installed" }),
    });
    const report = await lib.startPrewarm(state, undefined, {
      ...lib.createPrewarmIO(),
      sleep: async () => undefined,
    });
    const byStep = Object.fromEntries(report.outcomes.map((o) => [o.step, o]));
    expect(byStep["turn"]?.state).toBe("skipped");
    expect(byStep["tts"]).toMatchObject({ state: "failed", reason: "Supertonic is not installed" });
    expect(byStep["acks"]?.state).toBe("failed");
    expect(prewarmDoctorRows().map((row) => row.id)).toEqual([
      "voice:prewarm-tts",
      "voice:prewarm-acks",
    ]);
    expect(lib.ackMemory.ids()).toEqual([]);
  });

  it("the browser preview has no bridge: everything is skipped and nothing throws", async () => {
    g.window = {};
    const report = await lib.startPrewarm(state);
    expect(report.outcomes.map((o) => o.state)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(report.outcomes[0]?.reason).toMatch(/no desktop bridge/);
  });

  it("cancelling drops the lines already made and a line that finishes afterwards", async () => {
    ackOn();
    let release: (value: unknown) => void = () => undefined;
    let calls = 0;
    g.window = bridge({
      speakNeuralPcm: async (req: { text: string }) => {
        calls += 1;
        (sent["speak"] ??= []).push(req);
        const done = {
          ok: true,
          sampleRate: 44_100,
          pcm: new Uint8Array(new Int16Array(441).fill(900).buffer),
        };
        // The warm-up phrase and the first line answer at once; the second line waits for the test.
        return calls <= 2 ? done : new Promise((resolve) => (release = () => resolve(done)));
      },
    });
    const pass = lib.startPrewarm(state);
    await vi.waitFor(() => expect(calls).toBe(3));
    expect(lib.ackMemory.ids()).toEqual([ACK_LINES[0]?.id]);
    lib.cancelPrewarm();
    expect(lib.ackMemory.ids()).toEqual([]);
    release(undefined);
    await pass;
    expect(lib.ackMemory.ids()).toEqual([]);
    // The cancelled pass is not what Voice Doctor reports.
    expect(lastPrewarmReport()).toBeNull();
  });
});

describe("wiring of the warm-up (source-pinned; the live path cannot run here)", () => {
  const mode = source("src/lib/friday/assistant-mode.ts");

  it("the setting defaults on and has one toggle row and a flow registry entry", () => {
    expect(source("src/lib/friday/preferences.ts")).toMatch(/prewarm: true,/);
    expect(source("src/lib/friday/flow-registry.gen.ts")).toContain('"voice.prewarm"');
    const ui = source("src/components/friday/settings/VoiceSettings.tsx");
    expect(ui.match(/prefs\.voice\.prewarm !== false/g)).toHaveLength(1);
    expect(ui).toContain("preferences.setVoice({ prewarm:");
  });

  it("starts only after the microphone opened, from the Auto mic path, never from enterAuto", () => {
    const enter = mode.slice(
      mode.indexOf("private enterAuto()"),
      mode.indexOf("private startPrewarmPass()"),
    );
    expect(enter).not.toContain("startPrewarm");
    const open = mode.slice(
      mode.indexOf("private openAutoMic()"),
      mode.indexOf("private enterAuto()"),
    );
    expect(open.indexOf("this.state.micReady = true;")).toBeGreaterThan(-1);
    expect(open.indexOf("this.state.micReady = true;")).toBeLessThan(
      open.indexOf("this.startPrewarmPass();"),
    );
    // not in the failure branches
    expect(open.slice(0, open.indexOf("this.state.micReady = true;"))).not.toContain(
      "startPrewarmPass",
    );
    expect(mode.match(/this\.startPrewarmPass\(\)/g)).toHaveLength(2);
    const pass = mode.slice(
      mode.indexOf("private startPrewarmPass()"),
      mode.indexOf("private stampPrewarm"),
    );
    expect(pass).toContain('this.state.mode !== "auto"');
    expect(pass).toContain("micOpen: this.state.micReady");
    expect(pass).toContain("this.state.paused || this.state.muted || this.stopped()");
    expect(pass).toContain("localVoice: this.offlineVoiceReady");
  });

  it("is cancelled by pause, mute, Stop everything and leaving Auto, and stamps its timings", () => {
    expect(mode).toMatch(/if \(this\.stopped\(\)\) \{\s*cancelPrewarm\(\);/);
    expect(mode).toMatch(/if \(paused\) \{\s*cancelPrewarm\(\);\s*this\.stopRecognition\(\);/);
    expect(mode).toMatch(/if \(muted\) cancelPrewarm\(\);/);
    const leave = mode.slice(
      mode.indexOf("private leaveAuto()"),
      mode.indexOf("private startRecognition"),
    );
    expect(leave).toContain("cancelPrewarm();");
    expect(mode).toContain("voiceLatency.record(`prewarm.${outcome.step}`, outcome.ms)");
    expect(mode).toContain('this.trace("segment", prewarmLine(report))');
  });

  it("opens no microphone and plays nothing: the engines file uses no capture or playback call", () => {
    const wiring = source("src/lib/friday/voice-prewarm.ts");
    expect(wiring).not.toMatch(
      /getUserMedia|voiceGate|speakText|playBase64|new Audio|AudioContext/,
    );
    expect(wiring).toContain("provisional: true");
    expect(wiring).toContain("localOnly: true");
    expect(wiring).not.toMatch(/askFriday|chat\(|sendChat|streamChat|openrouter|fetch\(/i);
    const core = source("src/lib/friday/voice-engine/prewarm.ts");
    expect(core).not.toMatch(/\bwindow\b|Date\.now|setTimeout|from "\.\.\/(?!voice)/);
  });

  it("the layer rows of Voice Doctor include the pass", () => {
    const doctor = source("src/lib/friday/voice-doctor.ts");
    expect(doctor).toContain("rows.push(...prewarmDoctorRows());");
  });
});
