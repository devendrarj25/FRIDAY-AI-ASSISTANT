import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  recordTurnBudget,
  stampEndpoint,
  voiceBudgetLine,
} from "../../src/lib/friday/assistant-mode";
import {
  LatencyMonitor,
  StageClock,
  UNSTAMPED_STAGES,
  VOICE_STAGES,
} from "../../src/lib/friday/voice-engine/latency-monitor";

/** A fixed-clock turn: speech 0..1000, endpoint hold 400, first sound 700 ms after the speech end. */
function turn(firstSoundAt: number, monitor: LatencyMonitor) {
  const clock = new StageClock(() => 0);
  clock.mark("micSpeechStart", 0);
  stampEndpoint(clock, 400, 1000);
  clock.mark("sttFinalReceived", 1200);
  clock.mark("brainRequestStarted", 1210);
  clock.mark("brainFirstToken", 1300);
  clock.mark("ttsRequestStarted", 1350);
  clock.mark("ttsFirstAudioReceived", 1500);
  clock.mark("playbackFirstSample", firstSoundAt);
  return { clock, recorded: recordTurnBudget(clock, monitor) };
}

describe("voice latency budget wiring", () => {
  it("a simulated turn stamps the endpoint and ends with a recorded budget turn", () => {
    const monitor = new LatencyMonitor();
    const { clock, recorded } = turn(1600, monitor);
    expect(recorded).toBe(true);
    expect(clock.at("micSpeechEnd")).toBe(600);
    expect(clock.at("endpointConfirmed")).toBe(1000);
    const v = monitor.budgetVerdict();
    expect(v.turns).toBe(1);
    expect(v.firstSound?.p50).toBe(1000);
    expect(v.stages.eou?.p50).toBe(400);
    expect(v.stages.finalAsr?.p50).toBe(200);
    expect(v.stages.llmFirstToken?.p50).toBe(90);
    expect(v.stages.ttsFirstByte?.p50).toBe(150);
  });

  it("a turn with no first sound records nothing, and the speech end never precedes the speech start", () => {
    const monitor = new LatencyMonitor();
    const clock = new StageClock(() => 0);
    clock.mark("micSpeechStart", 500);
    stampEndpoint(clock, 5000, 900);
    expect(clock.at("micSpeechEnd")).toBe(500);
    expect(recordTurnBudget(clock, monitor)).toBe(false);
    expect(monitor.budgetVerdict().verdict).toBe("unmeasured");
  });

  it("the diagnostics row reads unmeasured, within, slow end and over honestly", () => {
    const monitor = new LatencyMonitor();
    expect(voiceBudgetLine(monitor)).toBe("no voice turn measured yet");
    turn(1300, monitor); // first sound 700 ms after speech end
    expect(voiceBudgetLine(monitor)).toMatch(/within budget, biggest stage/);
    expect(voiceBudgetLine(monitor)).toMatch(/700 ms typical, 700 ms slow end/);
    const slow = new LatencyMonitor();
    for (let i = 0; i < 4; i++) turn(1300, slow);
    turn(3000, slow);
    expect(voiceBudgetLine(slow)).toMatch(/slow end is over budget/);
    const over = new LatencyMonitor();
    turn(3000, over);
    expect(voiceBudgetLine(over)).toMatch(/, over budget, biggest stage/);
  });

  it("assistant mode stamps at the existing mic and playback events and the row is in the diagnostics", () => {
    const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    expect(mode).toMatch(/listening === "thinking"\)\s*stampEndpoint\(this\.turnStages/);
    expect(mode).toMatch(
      /mark\("playbackFirstSample"\);\s*if \(!this\.budgetRecorded\) this\.budgetRecorded = recordTurnBudget/,
    );
    const ui = readFileSync("src/components/friday/VoiceDiagnostics.tsx", "utf8");
    expect(ui).toContain("Voice latency budget");
    expect(ui).toContain("voiceBudgetLine()");
  });

  it("the true first brain token is stamped where the answer first appears, never in speak()", () => {
    const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    const speak = /private speak\(text: string\) \{[\s\S]*?\n {2}\}\n/.exec(mode)?.[0] ?? "";
    expect(speak).toContain("tokenAt");
    expect(speak).not.toContain('mark("brainFirstToken")');
    expect(mode).toMatch(/if \(live\?\.answer\) \{\s*this\.turnStages\.mark\("brainFirstToken"\);/);
    expect(mode).toMatch(/mark\("firstClauseReady"\);\s*this\.voicedChars \+= chunk\.consumed/);
    expect(mode).toMatch(/this\.narrator\.begin\(\);\s*this\.turnStages\.mark\("ackArmed"\)/);
  });

  it("every voice stage is stamped at a source site or listed as not yet used, and the list stays honest", () => {
    const dir = "src/lib/friday";
    const files = [
      "assistant-mode.ts",
      ...["sarvam-realtime-stt.ts", "sarvam-streaming-tts.ts"].map((f) => join("voice-engine", f)),
    ];
    const source = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    for (const stage of VOICE_STAGES) {
      const stamped = new RegExp(`mark\\(\\s*"${stage}"`).test(source);
      const unused = (UNSTAMPED_STAGES as readonly string[]).includes(stage);
      expect(stamped !== unused, `${stage}: stamped=${stamped} unused=${unused}`).toBe(true);
    }
  });

  it("the diagnostics show the new figures and the stages nothing stamps", () => {
    const ui = readFileSync("src/components/friday/VoiceDiagnostics.tsx", "utf8");
    for (const metric of [
      "finalToFirstAudible",
      "endToFirstAudible",
      "brainTokenToFirstAudible",
      "firstClauseToFirstAudible",
      "eagerOverlap",
      "ackArmedToAudible",
    ])
      expect(ui).toContain(`figureLine("${metric}")`);
    expect(ui).toContain("unstampedStagesLine()");
    expect(ui).toContain("speech end is an estimate");
    expect(ui).toContain("Voice latency budget (speech end to first sound)");
  });
});
