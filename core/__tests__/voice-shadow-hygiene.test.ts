/**
 * The turn engine shadow keeps nothing it does not need, runs after the live path, and follows the session. Each case
 * runs the real Auto mode controller through the turn simulator: the barge-in audio is dropped once the verdict was
 * taken, the adapter is dropped when Auto ends, on Stop everything and on mute, the engine's own state holds at most
 * 80 scrubbed characters (and nothing of a private line), the shadow's feeds run after the live action, the adapter
 * follows `voice.turn`, the local voice breaker and the install state reach the voice ladder, and the barge-in
 * detector reads the echo-cleaned level when the echo reference runs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TurnEngineAdapter } from "../../src/lib/friday/assistant-mode";
import type { StreamTurn } from "../../src/lib/friday/voice-engine/stream-session";
import { SCENARIOS } from "./helpers/voice-turn-scenarios";
import {
  ctl,
  ear,
  quiet,
  runScenario,
  script,
  vad,
  type Scenario,
  type SimHarness,
} from "./helpers/voice-turn-sim";

vi.mock("../../src/lib/friday/voice-library", async (importOriginal) =>
  (await import("./helpers/voice-turn-sim")).simLibraryMock(await importOriginal()),
);

type Tap = (samples: ArrayLike<number>, rate: number, atMono: number) => void;
type Hooks = { taps: Tap[]; cleaned: number | null };
const HOOKS = "__voiceShadowHygiene";
const hooks = (): Hooks => {
  const g = globalThis as unknown as Record<string, Hooks | undefined>;
  return (g[HOOKS] ??= { taps: [], cleaned: null });
};

// The capture is a recorder here: the test plays the frames, and says what the echo-cleaned level is.
vi.mock("../../src/lib/friday/pcm-capture", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/friday/pcm-capture")>();
  return {
    ...real,
    subscribeCaptureFrames: (tap: Tap) => {
      hooks().taps.push(tap);
      return () => {
        const taps = hooks().taps;
        const i = taps.indexOf(tap);
        if (i >= 0) taps.splice(i, 1);
      };
    },
    cleanedLevel: () => hooks().cleaned,
  };
});

const SOURCE = readFileSync(resolve(__dirname, "../../src/lib/friday/assistant-mode.ts"), "utf8");

type Priv = {
  turnShadow: TurnEngineAdapter | null;
  turnShadowBroken: boolean;
  turnShadowAdapter: () => TurnEngineAdapter | null;
  bargeMicLevel: number;
  offlineVoiceReady: boolean;
  startBargeShadow: () => void;
  requestTtsRestart: () => void;
  speakPlan: (spoken: string) => { fallen: string };
  echoReferenceLive: () => boolean;
};
const P = (h: SimHarness): Priv => h.d as unknown as Priv;
const framesOf = (a: TurnEngineAdapter): number =>
  (a as unknown as { audioFrames: unknown[] }).audioFrames.length;

const tone = (rate: number, amp = 0.3): Float32Array =>
  new Float32Array(Math.round(rate / 50)).map(
    (_, i) => amp * Math.sin((2 * Math.PI * 180 * i) / rate),
  );

function withSetup(base: Scenario, extra: (h: SimHarness) => void): Scenario {
  return {
    ...base,
    setup: (h) => {
      base.setup?.(h);
      extra(h);
    },
  };
}

describe("shadow hygiene: the barge-in audio is dropped once the verdict was taken (finding 4)", () => {
  it("holds no frames after a real interruption, though frames were collected while it lasted", async () => {
    hooks().taps.length = 0;
    let seen = 0;
    const r = await runScenario(
      withSetup(SCENARIOS["interruption"] as Scenario, (h) => {
        const a = P(h).turnShadowAdapter()!;
        const real = a.audio.bind(a);
        vi.spyOn(a, "audio").mockImplementation((samples, rate) => {
          real(samples, rate);
          seen += 1;
        });
        setInterval(() => {
          for (const tap of hooks().taps.slice()) tap(tone(16000), 16000, performance.now());
        }, 80);
      }),
    );
    expect(seen).toBeGreaterThan(0);
    const a = P(r.h).turnShadow;
    expect(a).not.toBeNull();
    expect(a!.report().counters.verdicts).toBeGreaterThan(0);
    expect(framesOf(a!)).toBe(0);
  });

  it("the adapter keeps the frames for the verdict taken right after the candidate closed, then lets go", async () => {
    const r = await runScenario({ name: "boot", script: [] });
    const Adapter = P(r.h).turnShadowAdapter()!.constructor as new (
      ...args: ConstructorParameters<typeof TurnEngineAdapter>
    ) => TurnEngineAdapter;
    const a = new Adapter({ handsFree: () => true, maxWaitMs: 2400, calibrate: false, startAt: 0 });
    const input = {
      words: ["wait"],
      voiceMs: 600,
      vadP: 0.9,
      ttsPlaying: true,
      playedMs: 900,
      echoClean: true,
      scene: "quiet" as const,
      speaker: "unknown" as const,
      sinceTtsStartMs: 900,
    };
    a.bargeBegin(1000);
    for (let i = 0; i < 5; i += 1) a.audio(tone(16000), 16000);
    a.holdAudioForVerdict();
    a.bargeEnd();
    expect(framesOf(a)).toBeGreaterThan(0);
    expect(a.barge("takeover", input, 1500).trace?.acoustic.voicedMs).toBeGreaterThan(0);
    expect(framesOf(a)).toBe(0);
    // A candidate that ends with no verdict to come holds nothing at all.
    a.bargeBegin(2000);
    for (let i = 0; i < 5; i += 1) a.audio(tone(16000), 16000);
    expect(framesOf(a)).toBeGreaterThan(0);
    a.bargeEnd();
    expect(framesOf(a)).toBe(0);
  });
});

describe("shadow hygiene: the adapter is dropped with the session (finding 4)", () => {
  const base = SCENARIOS["clean"] as Scenario;

  it("is dropped when Auto ends, and the broken flag is cleared for the next session", async () => {
    const r = await runScenario(
      withSetup(base, (h) => {
        setTimeout(() => {
          P(h).turnShadowBroken = true;
          (h.d as unknown as { setMode: (mode: string) => void }).setMode("manual");
        }, 2800);
      }),
    );
    expect(P(r.h).turnShadow).toBeNull();
    expect(P(r.h).turnShadowBroken).toBe(false);
  });

  it("is dropped on Stop everything, after the stop-all feed, and starts fresh", async () => {
    const order: string[] = [];
    let first: TurnEngineAdapter | null = null;
    const r = await runScenario(
      withSetup(
        {
          ...base,
          script: script(base.script, ctl(2800, "stop-all")),
        },
        (h) => {
          first = P(h).turnShadowAdapter()!;
          const real = first.control.bind(first);
          vi.spyOn(first, "control").mockImplementation((ev, now, expect) => {
            order.push(`${ev}:stops=${h.brainStops.length}`);
            real(ev, now, expect);
          });
        },
      ),
    );
    expect(P(r.h).turnShadow).toBeNull();
    // The live stop (the Brain's) happened before the shadow heard about it.
    const fed = order.find((row) => row.startsWith("stop-all:"));
    expect(fed).toBeDefined();
    expect(Number(fed!.split("=")[1])).toBeGreaterThanOrEqual(1);
    expect(first).not.toBeNull();
  });

  it("is dropped on mute, after the live mute took effect", async () => {
    let mutedWhenFed: boolean | null = null;
    const r = await runScenario(
      withSetup({ ...base, script: script(base.script, ctl(2800, "mute")) }, (h) => {
        const a = P(h).turnShadowAdapter()!;
        const real = a.control.bind(a);
        vi.spyOn(a, "control").mockImplementation((ev, now, expect) => {
          if (ev === "mute") mutedWhenFed = h.d.state.muted === true;
          real(ev, now, expect);
        });
      }),
    );
    expect(mutedWhenFed).toBe(true);
    expect(P(r.h).turnShadow).toBeNull();
  });
});

describe("shadow hygiene: the engine's own state keeps little (finding 7)", () => {
  async function make(): Promise<TurnEngineAdapter> {
    const r = await runScenario({ name: "boot", script: [] });
    const Adapter = P(r.h).turnShadowAdapter()!.constructor as new (
      ...args: ConstructorParameters<typeof TurnEngineAdapter>
    ) => TurnEngineAdapter;
    return new Adapter({ handsFree: () => true, maxWaitMs: 2400, calibrate: false, startAt: 0 });
  }
  const turn = (event: StreamTurn["event"], text: string): StreamTurn => ({
    turnId: "t1",
    event,
    text,
    vadP: 0.9,
    speechMs: null,
  });

  it("keeps at most 80 scrubbed characters of a long partial, in the state and in a draft", async () => {
    const a = await make();
    const long = `Friday please call 9876543210 about invoice 5521 ${"and remember the long sentence ".repeat(6)}`;
    a.ear(turn("start", ""), 0);
    for (let t = 0; t < 800; t += 80) a.vad(true, true, t);
    a.ear(turn("partial", long), 800);
    a.ear(turn("eager", long), 880);
    const state = a.engineState();
    expect(state.text.length).toBeGreaterThan(0);
    expect(state.text.length).toBeLessThanOrEqual(80);
    expect(state.text).not.toMatch(/\d/);
    expect(state.draft.text.length).toBeLessThanOrEqual(80);
    expect(state.draft.text).not.toMatch(/\d/);
    expect(JSON.stringify(state)).not.toContain("9876543210");
  });

  it("keeps nothing of a private line", async () => {
    const a = await make();
    a.ear(turn("start", ""), 0);
    for (let t = 0; t < 800; t += 80) a.vad(true, true, t);
    a.ear(turn("partial", "my password is hunter two and my PIN is 4821"), 800);
    a.ear(turn("eager", "my password is hunter two and my PIN is 4821"), 880);
    const state = JSON.stringify(a.engineState());
    expect(state).not.toMatch(/hunter|4821|password|PIN/i);
  });

  it("still ends the turn the way the live one does with the scrubbed text", async () => {
    const a = await make();
    a.ear(turn("start", ""), 0);
    for (let t = 0; t < 800; t += 80) a.vad(true, true, t);
    a.ear(turn("partial", "Friday what is the time"), 800);
    for (let t = 880; t < 2400; t += 80) a.vad(false, true, t);
    expect(a.engineState().state).toBe("think");
  });
});

describe("shadow hygiene: the shadow feeds run after the live action (finding 8)", () => {
  it("the final reaches the shadow after the live handling of that turn", async () => {
    const seenSent: number[] = [];
    await runScenario(
      withSetup(SCENARIOS["clean"] as Scenario, (h) => {
        const a = P(h).turnShadowAdapter()!;
        const real = a.liveFinal.bind(a);
        vi.spyOn(a, "liveFinal").mockImplementation((text, now) => {
          seenSent.push(h.sent.length);
          real(text, now);
        });
      }),
    );
    expect(seenSent).toEqual([1]);
  });

  it("the dispatch feed follows the Brain's send in source", () => {
    const start = SOURCE.indexOf("affect.noteVoice({ tone: this.lastTone");
    expect(start).toBeGreaterThan(-1);
    const send = SOURCE.indexOf("let result = brain.send(command, payload);", start);
    const feed = SOURCE.indexOf("a.dispatch(command, Date.now())", start);
    expect(send).toBeGreaterThan(-1);
    expect(feed).toBeGreaterThan(send);
  });

  it("the stop-all and mute feeds come after the live work, in source", () => {
    const stop = SOURCE.indexOf("private followKillSwitch()");
    const stopEnd = SOURCE.indexOf("this.emit();\n      return;", stop);
    const stopFeed = SOURCE.indexOf('a.control("stop-all"', stop);
    expect(stopFeed).toBeGreaterThan(SOURCE.indexOf("brain.stop();", stop));
    expect(stopFeed).toBeLessThan(stopEnd);
    const mute = SOURCE.indexOf("setMuted(muted: boolean)");
    const muteFeed = SOURCE.indexOf('a.control("mute"', mute);
    expect(muteFeed).toBeGreaterThan(SOURCE.indexOf("this.startRecognition();", mute));
  });
});

describe("shadow hygiene: the adapter follows voice.turn (finding 9)", () => {
  const setTurn = (h: SimHarness, patch: { maxWaitMs?: number; calibrate?: boolean }) =>
    h.preferences.setVoice({ turn: { ...h.preferences.getSnapshot().voice.turn, ...patch } });

  it("is the same adapter while voice.turn is unchanged, and a new one when the longest wait changes", async () => {
    const r = await runScenario(SCENARIOS["clean"] as Scenario);
    const same = P(r.h).turnShadowAdapter();
    expect(same).toBe(P(r.h).turnShadowAdapter());
    expect(same!.engineState().cfg.maxWaitFrames).toBe(30);
    setTurn(r.h, { maxWaitMs: 3600 });
    const rebuilt = P(r.h).turnShadowAdapter();
    expect(rebuilt).not.toBe(same);
    expect(rebuilt!.engineState().cfg.maxWaitFrames).toBe(45);
    expect(P(r.h).turnShadowAdapter()).toBe(rebuilt);
  });

  it("is rebuilt when calibration is switched, and an unrelated preference keeps it", async () => {
    const r = await runScenario(SCENARIOS["clean"] as Scenario);
    const first = P(r.h).turnShadowAdapter();
    r.h.preferences.setVoice({ approvalTtlSec: 20 });
    expect(P(r.h).turnShadowAdapter()).toBe(first);
    setTurn(r.h, { calibrate: true });
    expect(P(r.h).turnShadowAdapter()).not.toBe(first);
  });

  it("says in the source that a stored live classifier still only shadows", () => {
    expect(SOURCE).toMatch(/"live" both run it as a shadow in\s+\* this build/);
  });
});

describe("shadow hygiene: the voice ladder hears the breaker and the install state (finding 5)", () => {
  async function installerOf() {
    const { installer } = await import("../../src/lib/friday/installer-engine");
    return installer as unknown as {
      state: { installed: Record<string, string | null> };
      emit: () => void;
    };
  }

  it("a repeated restart answer of breaker-open takes FRIDAY Voice out of the ladder until the cool-down ends", async () => {
    const r = await runScenario({ name: "boot", script: [] });
    const d = P(r.h);
    d.offlineVoiceReady = true;
    expect(d.speakPlan("The time is ten past three.").fallen).toBe("supertonic");
    const g = globalThis as unknown as { friday?: Record<string, unknown> };
    g.friday = {
      ...g.friday,
      restartTts: async () => ({ ok: false, state: "breaker-open" }),
    };
    d.requestTtsRestart();
    await Promise.resolve();
    await Promise.resolve();
    expect(d.speakPlan("The time is ten past three.").fallen).not.toBe("supertonic");
    const real = Date.now;
    try {
      Date.now = () => real() + 301_000;
      expect(d.speakPlan("The time is ten past three.").fallen).toBe("supertonic");
    } finally {
      Date.now = real;
    }
  });

  it("offline readiness follows the installer both ways on every event", async () => {
    const r = await runScenario({ name: "boot", script: [] });
    const d = P(r.h);
    const installer = await installerOf();
    // The subscription is made in a dynamic import: let it finish.
    await new Promise((resolve) => setTimeout(resolve, 0));
    installer.state.installed = { ...installer.state.installed, supertonic: "1.0" };
    installer.emit();
    expect(d.offlineVoiceReady).toBe(true);
    installer.state.installed = { ...installer.state.installed, supertonic: null };
    installer.emit();
    expect(d.offlineVoiceReady).toBe(false);
  });
});

describe("shadow hygiene: the barge-in detector reads the echo-cleaned level (finding 12)", () => {
  async function levelWith(echoLive: boolean, cleaned: number | null): Promise<number> {
    hooks().taps.length = 0;
    hooks().cleaned = cleaned;
    let level = -1;
    await runScenario({
      name: "level",
      script: script(ear(0, "start", "t1"), vad(0, 80), quiet(80, 160)),
      setup: (h) => {
        const d = P(h);
        vi.spyOn(d, "echoReferenceLive").mockReturnValue(echoLive);
        h.d.state.speaking = true;
        const tap = hooks().taps.at(-1);
        expect(tap).toBeDefined();
        tap!(tone(16000, 0.5), 16000, performance.now());
        level = d.bargeMicLevel;
      },
    });
    hooks().cleaned = null;
    return level;
  }

  it("uses the cleaned level while the echo reference runs", async () => {
    expect(await levelWith(true, 0.04)).toBeCloseTo(0.04, 5);
  });

  it("keeps the raw microphone level with no echo reference, and when no cleaned frame exists", async () => {
    const raw = await levelWith(false, 0.04);
    expect(raw).toBeGreaterThan(0.3);
    expect(await levelWith(true, null)).toBeCloseTo(raw, 5);
  });
});
