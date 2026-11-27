/**
 * The turn engine in shadow. The Auto mode controller feeds the pure turn engine (`voice-engine/turn-engine.ts`) the
 * same events its live path sees, asks the interruption classifier for a verdict next to the live barge-in gate, and
 * only counts where the two agree. Nothing the engine or the classifier says is acted on: every scenario of the turn
 * simulator does exactly the same with the shadow on and with it off, and a shadow that throws is dropped without
 * touching the turn. `voice.turn.classifier: "off"` creates no adapter at all.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TurnEngineAdapter } from "../../src/lib/friday/assistant-mode";
import { LatencyMonitor } from "../../src/lib/friday/voice-engine/latency-monitor";
import type { InterruptionInput } from "../../src/lib/friday/voice-engine/interruption-controller";
import type { StreamTurn } from "../../src/lib/friday/voice-engine/stream-session";
import { SCENARIOS } from "./helpers/voice-turn-scenarios";
import {
  runScenario,
  type Scenario,
  type SimHarness,
  type SimResult,
} from "./helpers/voice-turn-sim";

vi.mock("../../src/lib/friday/voice-library", async (importOriginal) =>
  (await import("./helpers/voice-turn-sim")).simLibraryMock(await importOriginal()),
);

const SOURCE = readFileSync(resolve(__dirname, "../../src/lib/friday/assistant-mode.ts"), "utf8");

type ShadowView = {
  turnShadow: TurnEngineAdapter | null;
  turnShadowBroken: boolean;
  turnShadowAdapter: () => TurnEngineAdapter | null;
};
const view = (h: SimHarness): ShadowView => h.d as unknown as ShadowView;

/** What she did, and nothing else: the trace (voice, ear, dispatch, say, duck, stop, cancel), lines and Brain calls. */
function actions(r: SimResult) {
  return {
    trace: r.trace,
    spoken: r.spoken,
    sent: r.sent,
    cancelled: r.cancelled,
    truncated: r.h.truncated,
    drafts: r.h.drafts,
    brainStops: r.h.brainStops,
    hints: r.h.hints,
  };
}

function withSetup(base: Scenario, extra: (h: SimHarness) => void): Scenario {
  return {
    ...base,
    setup: (h) => {
      base.setup?.(h);
      extra(h);
    },
  };
}

const classifier = (value: "off" | "shadow" | "live") => (h: SimHarness) =>
  h.preferences.setVoice({
    turn: { ...h.preferences.getSnapshot().voice.turn, classifier: value },
  });

describe("turn engine shadow: the product calls it (source)", () => {
  it("imports the pure turn engine, the classifier, the acoustic features, the recorder and the calibration book", () => {
    expect(SOURCE).toMatch(
      /import \{[^}]*\bcreateTurnEngine\b[^}]*\bstep\b[^}]*\} from "\.\/voice-engine\/turn-engine"/,
    );
    expect(SOURCE).toMatch(
      /\bclassifyInterruption\b[^;]*from "\.\/voice-engine\/interruption-controller"/s,
    );
    expect(SOURCE).toContain('from "./voice-engine/interrupt-acoustic"');
    expect(SOURCE).toContain("createTurnMetricsRecorder(");
    expect(SOURCE).toContain("new CalibrationBook()");
    expect(SOURCE).toContain("step(this.engine,");
    expect(SOURCE).toContain("classifyInterruption(full)");
    expect(SOURCE).toContain("acousticFeatures(");
  });

  it("is created only when the classifier is not off, with lang auto, a three-frame onset and the dictation expectation", () => {
    expect(SOURCE).toMatch(/classifier === "off"/);
    expect(SOURCE).toMatch(/lang: "auto"/);
    expect(SOURCE).toMatch(/onsetFrames: 3/);
    expect(SOURCE).toMatch(/voiceNotes\.active\(\)\s*\?\s*"dictation"/);
  });

  it("feeds the engine at the live seams and asks the classifier next to both live barge-in judges", () => {
    const at = (needle: string) => {
      const i = SOURCE.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    // The stream ear, the desktop partials, the final transcript, the hand-over to the Brain, the voice start and end.
    expect(SOURCE).toMatch(
      /noteStreamTurn\(turn: StreamTurn\) \{[\s\S]{0,2400}a\.ear\(turn, now\)/,
    );
    expect(SOURCE).toMatch(/const plan = partialPlan\(\{[\s\S]{0,1600}a\.partial\(text, now\)/);
    expect(SOURCE).toMatch(/private handleHeard\([\s\S]{0,900}a\.liveFinal\(text,/);
    expect(SOURCE).toMatch(
      /a\.dispatch\(command, Date\.now\(\)\)\);\s*let result = brain\.send\(command, payload\)/,
    );
    expect(SOURCE).toMatch(/onStart: \(\) => \{[\s\S]{0,700}a\.tts\("first-audio"/);
    expect(SOURCE).toMatch(/onEnd: \(\) => \{[\s\S]{0,700}a\.tts\(/);
    // The live gate decides first; the shadow verdict is taken after it and before the live verdict is applied.
    const judged = at("const verdict = this.judgeCandidate(input);");
    const shadow = SOURCE.indexOf("const shadow = this.shadowBarge(", judged);
    const applied = SOURCE.indexOf("this.applyGateVerdict(verdict);", judged);
    expect(shadow).toBeGreaterThan(judged);
    expect(applied).toBeGreaterThan(shadow);
    // The classifier itself runs only after the live verdict was applied, so it never delays a stop.
    expect(SOURCE.slice(applied, applied + 80)).toMatch(
      /applyGateVerdict\(verdict\);\s*shadow\(\);/,
    );
    const legacy = at("const verdict = judgeInterruption(text, {");
    expect(SOURCE.indexOf("const shadow = this.shadowJudge(verdict, text);", legacy)).toBeGreaterThan(legacy);
    expect(SOURCE.indexOf("const shadow = this.shadowJudge(verdict, text);", legacy)).toBeLessThan(
      SOURCE.indexOf('if (verdict === "resume")', legacy),
    );
  });

  it("never lets a shadow command act: the adapter only counts, and every feed is fail-open", () => {
    const start = at2("export class TurnEngineAdapter");
    const end = SOURCE.indexOf("\n}\n", start);
    const body = SOURCE.slice(start, end);
    for (const banned of [
      "brain.",
      "this.dispatch",
      ".send(",
      "speakText(",
      "stopSpeaking",
      "duckSpeech",
      "confirmPending",
      "approve",
      "runApproved",
      "setPaused",
      "setMuted",
    ]) {
      expect(body, banned).not.toContain(banned);
    }
    expect(SOURCE).toMatch(
      /private shadowTurn\([\s\S]{0,600}catch \{[\s\S]{0,200}this\.turnShadowBroken = true/,
    );
  });

  it("uses the owner's approval window at every voice approval check and says no fixed 120 s", () => {
    const calls = SOURCE.match(/approvalFresh\([^;]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) expect(call).toContain("this.approvalTtl()");
    expect(SOURCE).toMatch(/approvalTtlMs\(preferences\.getSnapshot\(\)\.voice\.approvalTtlSec\)/);
    expect(SOURCE).not.toContain("for the next 120 s");
  });

  it("puts the agree and disagree counts next to the soak record, never audio", () => {
    expect(SOURCE).toMatch(/soakReport\(\): string \{[\s\S]{0,300}turnShadow:/);
  });
});

function at2(needle: string): number {
  const i = SOURCE.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
}

describe("turn engine shadow: behaviour on the real controller", () => {
  it("steps the engine and asks the classifier during a real interruption", async () => {
    const r = await runScenario(SCENARIOS["interruption"] as Scenario);
    const a = view(r.h).turnShadow;
    expect(a).not.toBeNull();
    const report = a!.report();
    expect(report.mode).toBe("shadow");
    expect(report.counters.steps).toBeGreaterThan(0);
    expect(report.counters.verdicts).toBeGreaterThan(0);
    expect(
      report.counters.agree + Object.values(report.counters.disagree).reduce((s, n) => s + n, 0),
    ).toBeGreaterThan(0);
  });

  it("steps the engine on a clean command and compares its commit with the live final", async () => {
    const r = await runScenario(SCENARIOS["clean"] as Scenario);
    const report = view(r.h).turnShadow!.report();
    expect(report.counters.steps).toBeGreaterThan(0);
    const compared = report.counters.agree + (report.counters.disagree["commit-missing"] ?? 0);
    expect(compared).toBeGreaterThanOrEqual(1);
  });

  it("off creates no adapter", async () => {
    const r = await runScenario(
      withSetup(SCENARIOS["interruption"] as Scenario, classifier("off")),
    );
    expect(view(r.h).turnShadow).toBeNull();
    expect(view(r.h).turnShadowAdapter()).toBeNull();
  });

  it("live is accepted but still only shadows in this build", async () => {
    const r = await runScenario(
      withSetup(SCENARIOS["interruption"] as Scenario, classifier("live")),
    );
    expect(view(r.h).turnShadow!.report().mode).toBe("shadow");
  });

  it("changes no action: all 21 scenarios do the same with the shadow on and off", async () => {
    const keys = Object.keys(SCENARIOS);
    expect(keys).toHaveLength(21);
    for (const key of keys) {
      const base = SCENARIOS[key] as Scenario;
      const on = await runScenario(withSetup(base, classifier("shadow")));
      const off = await runScenario(withSetup(base, classifier("off")));
      expect(view(on.h).turnShadow, key).not.toBeNull();
      expect(view(off.h).turnShadow, key).toBeNull();
      expect(actions(on), key).toEqual(actions(off));
    }
  }, 120_000);

  it("a throwing shadow is dropped and the turn goes on exactly as with it off", async () => {
    for (const key of ["clean", "interruption", "backchannel", "stopAll"]) {
      const base = SCENARIOS[key] as Scenario;
      const broken = await runScenario(
        withSetup(base, (h) => {
          const a = view(h).turnShadowAdapter();
          expect(a).not.toBeNull();
          for (const name of [
            "ear",
            "partial",
            "vad",
            "liveFinal",
            "barge",
            "control",
            "tts",
          ] as const)
            vi.spyOn(a!, name).mockImplementation(() => {
              throw new Error("shadow fault");
            });
        }),
      );
      const off = await runScenario(withSetup(base, classifier("off")));
      expect(view(broken.h).turnShadowBroken, key).toBe(true);
      expect(view(broken.h).turnShadow, key).toBeNull();
      expect(actions(broken), key).toEqual(actions(off));
    }
  }, 60_000);
});

describe("turn engine shadow: the adapter", () => {
  /** The class itself, taken from a controller built by the simulator (the store needs its globals). */
  let Adapter:
    (new (...args: ConstructorParameters<typeof TurnEngineAdapter>) => TurnEngineAdapter) | null =
    null;
  async function make(
    opts: Partial<ConstructorParameters<typeof TurnEngineAdapter>[0]> = {},
  ): Promise<{ a: TurnEngineAdapter; monitor: LatencyMonitor }> {
    if (!Adapter) {
      const r = await runScenario({ name: "boot", script: [] });
      Adapter = view(r.h).turnShadowAdapter()!.constructor as unknown as typeof Adapter;
    }
    const monitor = new LatencyMonitor();
    const a = new Adapter!({
      handsFree: () => true,
      maxWaitMs: 2400,
      calibrate: false,
      startAt: 0,
      monitor,
      ...opts,
    });
    return { a, monitor };
  }
  const turn = (turnId: string, event: StreamTurn["event"], text = ""): StreamTurn => ({
    turnId,
    event,
    text,
    vadP: 0.9,
    speechMs: null,
  });
  const voiced = (a: TurnEngineAdapter, from: number, to: number, on = true) => {
    for (let t = from; t < to; t += 80) a.vad(on, true, t);
  };

  it("is built with lang auto, a three-frame onset and the longest wait from voice.turn", async () => {
    const { a } = await make({ maxWaitMs: 3200 });
    const cfg = a.engineState().cfg;
    expect(cfg.lang).toBe("auto");
    expect(cfg.onsetFrames).toBe(3);
    expect(cfg.maxWaitFrames).toBe(40);
    expect(typeof cfg.barge).toBe("function");
  });

  it("passes the dictation expectation into the engine when a turn opens", async () => {
    const { a } = await make({ expectNow: () => "dictation" });
    a.ear(turn("t1", "start"), 0);
    expect(a.engineState().expect).toBe("dictation");
    expect(a.engineState().state).toBe("listen");
  });

  it("agrees when the engine committed before the live final, and counts a final it had not committed", async () => {
    const { a } = await make();
    a.ear(turn("t1", "start"), 0);
    voiced(a, 0, 800);
    a.ear(turn("t1", "partial", "Friday what is the time"), 800);
    voiced(a, 880, 2400, false);
    expect(a.engineState().state).toBe("think");
    a.liveFinal("Friday what is the time", 2480);
    expect(a.report().counters.agree).toBe(1);
    a.ear(turn("t2", "start"), 3000);
    a.ear(turn("t2", "partial", "open the notepad"), 3080);
    a.liveFinal("open the notepad", 3160);
    expect(a.report().counters.disagree["commit-missing"]).toBe(1);
  });

  it("counts an engine commit with no live final as commit-extra when the next turn starts", async () => {
    const { a } = await make();
    a.ear(turn("t1", "start"), 0);
    voiced(a, 0, 800);
    a.ear(turn("t1", "partial", "Friday kal ka meeting"), 800);
    voiced(a, 880, 2400, false);
    a.ear(turn("t2", "start"), 2480);
    expect(a.report().counters.disagree["commit-extra"]).toBe(1);
  });

  it("compares the classifier with the live gate, keeps acoustic features in the trace, and counts by kind", async () => {
    const { a } = await make();
    const input: InterruptionInput = {
      words: ["wait", "open", "the", "budget"],
      voiceMs: 900,
      vadP: 0.9,
      ttsPlaying: true,
      playedMs: 1200,
      echoClean: true,
      scene: "quiet",
      speaker: "unknown",
      sinceTtsStartMs: 1200,
    };
    a.bargeBegin(1000);
    const frame = new Float32Array(320).map(
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 180 * i) / 16000),
    );
    for (let i = 0; i < 10; i += 1) a.audio(frame, 16000);
    const d = a.barge("takeover", input, 1900);
    expect(d.decision).toBe("takeover");
    expect(d.trace?.acoustic.voicedMs).toBeGreaterThan(0);
    expect(a.report().counters.agree).toBe(1);
    a.barge("keep", input, 2000);
    expect(a.report().counters.disagree["barge:keep/takeover"]).toBe(1);
    a.barge(null, input, 2100);
    expect(a.report().counters.verdicts).toBe(3);
    expect(a.report().counters.agree).toBe(1);
  });

  it("keeps no text beyond 80 characters, and none of a private line", async () => {
    const { a } = await make();
    const long = `Friday ${"please remember this long sentence ".repeat(6)}`;
    a.ear(turn("t1", "start"), 0);
    a.ear(turn("t1", "partial", long), 80);
    voiced(a, 160, 2000, false);
    a.liveFinal("my PIN is 4821", 2080);
    const text = JSON.stringify(a.report());
    expect(text).not.toContain("4821");
    for (const row of a.report().log) expect(row.detail.length).toBeLessThanOrEqual(80);
    expect(text).not.toContain(long.trim());
  });

  it("records the last turn's metrics into the latency monitor once, and feeds the calibration book by language", async () => {
    const { a, monitor } = await make();
    a.ear(turn("t1", "start"), 0);
    voiced(a, 0, 800);
    a.ear(turn("t1", "partial", "Friday mujhe kal ka mausam batao"), 800);
    voiced(a, 880, 1200, false);
    a.ear(turn("t1", "end", "Friday mujhe kal ka mausam batao"), 1280);
    a.liveFinal("Friday mujhe kal ka mausam batao", 1360);
    a.dispatch("Friday mujhe kal ka mausam batao", 1400);
    a.tts("first-audio", "g1", 0, 2000);
    a.tts("drained", "g1", 900, 2900);
    a.tts("drained", "g1", 900, 3000);
    expect(monitor.summary("turn.eotWaitMs")).toMatchObject({ count: 1, last: 480 });
    expect(monitor.summary("turn.ttfaMs")).toMatchObject({ count: 1, last: 1200 });
    const report = a.report();
    expect(report.lastTurn).toMatchObject({ turnId: "t1", eotWaitMs: 480, ttfaMs: 1200 });
    expect(report.calibration.hinglish + report.calibration.hi + report.calibration.en).toBe(1);
  });

  it("never throws on a clock that steps back", async () => {
    const { a } = await make({ startAt: 10_000 });
    expect(() => {
      a.ear(turn("t1", "start"), 5_000);
      a.vad(true, true, 4_000);
      a.liveFinal("open the notepad", 3_000);
    }).not.toThrow();
  });
});
