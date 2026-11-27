/**
 * The Doctor's turn-taking, room and barge-in rows read what the stream turn path really counted. Before a turn is
 * timed the rows say "absent"; once the conductor has seen a turn they leave it. The barge-in row also says, in plain
 * words, when the ladder is on but has no echo-clean voice signal and the plain interrupt gate decides. Counts and
 * tags only: nothing here reads a speaker or approves anything.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { DEFAULT_VOICE_EARS, preferences } from "../../src/lib/friday/preferences";
import { earsStatsNow } from "../../src/lib/friday/voice-audio";
import { bargeInRow, earsRows } from "../../src/lib/friday/voice-diagnostics-rows";
import { TurnTracker, type StreamTurn } from "../../src/lib/friday/voice-engine/stream-session";
import {
  echoCleanSourceLive,
  echoReferenceRunning,
} from "../../src/lib/friday/voice-engine/interruption-controller";

(globalThis as unknown as { window?: unknown }).window ??= globalThis;

type Driver = {
  state: { mode: string; paused: boolean; muted: boolean };
  callHold: boolean;
  noteStreamTurn: (turn: StreamTurn) => void;
};
const drive = assistantMode as unknown as Driver;

const turn = (event: StreamTurn["event"], extra: Partial<StreamTurn> = {}): StreamTurn => ({
  turnId: "t1",
  event,
  text: "",
  vadP: 0.9,
  speechMs: 400,
  ...extra,
});

const rowOf = (id: string) =>
  earsRows({ ...DEFAULT_VOICE_EARS, scene: "score" }, earsStatsNow()).find((r) => r.id === id);

beforeEach(() => {
  drive.state.mode = "auto";
  drive.state.paused = false;
  drive.state.muted = false;
  drive.callHold = false;
});
afterEach(() => {
  preferences.setVoice({ interruptGate: { enabled: true, ladder: false } as never });
});

describe("the turn tracker keeps the facts the Doctor shows", () => {
  it("lastEndMs is the voiced time of the last end, and the room tag survives the turn", () => {
    const tracker = new TurnTracker();
    expect(tracker.lastEndMs).toBeNull();
    tracker.ingest(turn("start", { env: { kind: "tv", score: 0.7 } }), 1000);
    tracker.ingest(turn("end", { speechMs: 1320 }), 2400);
    expect(tracker.lastEndMs).toBe(1320);
    tracker.take(2500);
    expect(tracker.lastEnv).toEqual({ kind: "tv", score: 0.7 });
    expect(tracker.lastEndMs).toBe(1320);
  });
});

describe("the rows leave absent once a turn was timed", () => {
  it("turn taking and the room score read the live tracker", () => {
    // Before any turn there is nothing to show (this file's module state is fresh).
    expect(rowOf("ears-turn")?.state).toBe("absent");
    expect(rowOf("ears-scene")?.state).toBe("absent");
    drive.noteStreamTurn(turn("start", { env: { kind: "music", score: 0.62 } }));
    drive.noteStreamTurn(turn("eager", { text: "kal ka mausam" }));
    drive.noteStreamTurn(turn("resumed"));
    drive.noteStreamTurn(turn("eager", { text: "kal ka mausam batao" }));
    drive.noteStreamTurn(turn("end", { speechMs: 1250 }));
    const stats = earsStatsNow();
    expect(stats?.turn).toEqual({ lastEndMs: 1250, eager: 2, resumed: 1 });
    expect(stats?.scene).toEqual({ kind: "music", score: 0.62 });
    const turnRow = rowOf("ears-turn");
    expect(turnRow?.state).toBe("ok");
    expect(turnRow?.value).toContain("1250 ms");
    expect(turnRow?.value).toContain("2 early, 1 resumed");
    expect(rowOf("ears-scene")?.state).toBe("ok");
    expect(rowOf("ears-scene")?.value).toContain("music");
  });

  it("the barge-in row shows the resumed share from the same counts", () => {
    const row = bargeInRow({ ladder: true }, earsStatsNow());
    expect(row.value).toContain("2 early, 1 resumed (50% resumed)");
  });

  it("a turn the conductor ignores (muted) is not counted", () => {
    const before = earsStatsNow()?.turn;
    drive.state.muted = true;
    drive.noteStreamTurn(turn("eager", { turnId: "t9", text: "x" }));
    expect(earsStatsNow()?.turn).toEqual(before);
  });
});

describe("the barge-in row says when the ladder has no echo-clean signal", () => {
  it("on with neither source: absent, the requirement and the fallback in words", () => {
    const row = bargeInRow(
      { ladder: true },
      { bargeSource: { streaming: false, echoReference: false } },
    );
    expect(row.state).toBe("absent");
    expect(row.value).toMatch(/streaming ear or the echo reference/);
    expect(row.value).toMatch(/plain interrupt gate decides/);
  });

  it("on with a source: the ladder row as before", () => {
    const row = bargeInRow(
      { ladder: true },
      {
        bargeSource: { streaming: true, echoReference: false },
        turn: { lastEndMs: 100, eager: 4, resumed: 1 },
      },
    );
    expect(row.state).toBe("ok");
    expect(row.value).toContain("duck, then stop");
  });

  it("the live stats carry the source only while the ladder is on", () => {
    expect(earsStatsNow()?.bargeSource).toBeUndefined();
    // The ear switched off by the owner (auto is the shipped default now): no streaming source.
    preferences.setVoice({ streamEngine: "off" });
    preferences.setVoice({ interruptGate: { enabled: true, ladder: true } as never });
    expect(earsStatsNow()?.bargeSource).toEqual({ streaming: false, echoReference: false });
    preferences.setVoice({ streamEngine: "auto" });
    expect(earsStatsNow()?.bargeSource?.streaming).toBe(true);
    preferences.setVoice({ streamEngine: "nemotron" });
    expect(earsStatsNow()?.bargeSource?.streaming).toBe(true);
    preferences.setVoice({ streamEngine: "off" });
    expect(earsStatsNow()?.bargeSource?.streaming).toBe(false);
  });

  it("the source rule: the streaming ear or a reference that really cancelled frames", () => {
    expect(echoCleanSourceLive({ streaming: false, echoReference: false })).toBe(false);
    expect(echoCleanSourceLive({ streaming: true, echoReference: false })).toBe(true);
    expect(echoCleanSourceLive({ streaming: false, echoReference: true })).toBe(true);
    expect(echoCleanSourceLive(null)).toBe(false);
    expect(echoReferenceRunning({ enabled: true, attached: true, cancelledFrames: 0 })).toBe(false);
    expect(echoReferenceRunning({ enabled: true, attached: false, cancelledFrames: 9 })).toBe(
      false,
    );
    expect(echoReferenceRunning({ enabled: true, attached: true, cancelledFrames: 9 })).toBe(true);
  });
});

describe("the settings page states the requirement and the fallback", () => {
  it("under the toggle, in plain words, with the live fallback line", () => {
    const page = readFileSync(
      resolve(__dirname, "../../src/components/friday/settings/VoiceEarsSettings.tsx"),
      "utf8",
    );
    expect(page).toContain("Needs the streaming ear or the echo reference");
    expect(page).toContain("the plain interrupt gate decides");
    expect(page).toContain("echoCleanSourceLive(barge)");
  });
});
