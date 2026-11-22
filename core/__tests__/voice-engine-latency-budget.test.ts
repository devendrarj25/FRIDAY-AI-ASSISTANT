/** Per-turn latency budget: fixed clock, no devices. First sound is judged against 800 ms and the biggest stage is named. */
import { describe, expect, it } from "vitest";
import {
  LATENCY_BUDGET_MS,
  LatencyMonitor,
  StageClock,
  type VoiceStage,
} from "../../src/lib/friday/voice-engine/latency-monitor";

/** One turn with fixed stamps (ms); `llm` and `tts` shape the stages. */
function turn(
  monitor: LatencyMonitor,
  o: { eou: number; asr: number; llm: number; tts: number; lead?: number },
) {
  const clock = new StageClock(() => 0);
  let t = 1000;
  const mark = (stage: VoiceStage, add: number) => clock.mark(stage, (t += add));
  mark("micSpeechEnd", 0);
  mark("endpointConfirmed", o.eou);
  mark("sttFinalReceived", o.asr);
  mark("brainRequestStarted", 5);
  mark("brainFirstToken", o.llm);
  mark("ttsRequestStarted", o.lead ?? 5);
  mark("ttsFirstAudioReceived", o.tts);
  mark("playbackFirstSample", 20);
  return clock.finish(monitor);
}

describe("voice latency budget", () => {
  it("records the five budget stages from stamps, and none that did not happen", () => {
    const clock = new StageClock(() => 0);
    clock.mark("micSpeechEnd", 100);
    clock.mark("endpointConfirmed", 250);
    expect(clock.budgetTurn()).toEqual({ eou: 150 });
    clock.mark("sttFinalReceived", 330);
    clock.mark("brainRequestStarted", 340);
    clock.mark("brainFirstToken", 500);
    clock.mark("ttsRequestStarted", 505);
    clock.mark("ttsFirstAudioReceived", 585);
    clock.mark("playbackFirstSample", 600);
    expect(clock.budgetTurn()).toEqual({
      eou: 150,
      finalAsr: 80,
      llmFirstToken: 160,
      ttsFirstByte: 80,
      firstSound: 500,
    });
  });

  it("has no verdict before a turn is measured", () => {
    const v = new LatencyMonitor().budgetVerdict();
    expect(v).toMatchObject({
      verdict: "unmeasured",
      turns: 0,
      biggestStage: null,
      firstSound: null,
    });
    expect(v.budgetMs).toBe(LATENCY_BUDGET_MS);
    expect(LATENCY_BUDGET_MS).toBe(800);
  });

  it("says within budget and names the biggest stage", () => {
    const m = new LatencyMonitor();
    for (let i = 0; i < 5; i++) turn(m, { eou: 100, asr: 60, llm: 200, tts: 90 });
    const v = m.budgetVerdict();
    expect(v.verdict).toBe("within");
    expect(v.biggestStage).toBe("llmFirstToken");
    expect(v.firstSound?.p50).toBe(100 + 60 + 5 + 200 + 5 + 90 + 20);
  });

  it("says slow-tail when only the slow end breaks the budget, and over when typical turns do", () => {
    const m = new LatencyMonitor();
    for (let i = 0; i < 18; i++) turn(m, { eou: 100, asr: 60, llm: 200, tts: 90 });
    for (let i = 0; i < 2; i++) turn(m, { eou: 100, asr: 60, llm: 900, tts: 90 });
    expect(m.budgetVerdict().verdict).toBe("slow-tail");
    const slow = new LatencyMonitor();
    for (let i = 0; i < 5; i++) turn(slow, { eou: 500, asr: 100, llm: 400, tts: 200 });
    const v = slow.budgetVerdict();
    expect(v.verdict).toBe("over");
    expect(v.biggestStage).toBe("eou");
  });

  it("keeps a bounded window of the latest turns", () => {
    const m = new LatencyMonitor();
    for (let i = 0; i < 150; i++) turn(m, { eou: 100, asr: 60, llm: 200, tts: 90 });
    for (let i = 0; i < 100; i++) turn(m, { eou: 600, asr: 60, llm: 200, tts: 90 });
    const v = m.budgetVerdict();
    expect(v.turns).toBe(100);
    expect(v.stages.eou?.p50).toBe(600);
  });

  it("keeps the old durations output unchanged", () => {
    const clock = new StageClock(() => 0);
    clock.mark("micSpeechEnd", 1);
    clock.mark("endpointConfirmed", 2);
    expect(clock.durations()).toEqual({});
  });
});
