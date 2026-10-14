import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decideAddressing } from "../../src/lib/friday/addressing";
import {
  ambientContextForRoute,
  clearHeard,
  heardRows,
  noteHeard,
  resetHeardLog,
} from "../../src/lib/friday/heard-log";
import { microphoneAllowed } from "../../src/lib/friday/voice-session";
import {
  admitUtterance,
  allowRestart,
  collapseVoiceLog,
  durationBucket,
  encodeWav,
  micWatch,
  PcmRing,
  PRE_ROLL_MS,
  resetCaptureRing,
  segmentClock,
} from "../../src/lib/friday/pcm-capture";

describe("segment clock", () => {
  it("closes a two-hour wall gap at the cap and reports it once as a bug", () => {
    const clock = segmentClock({
      startedMono: 0,
      nowMono: 80,
      startedWall: 0,
      nowWall: 7_376_350,
      maxUtteranceMs: 20_000,
    });
    expect(clock.close).toBe(true);
    expect(clock.bug).toBe(true);
    expect(clock.reportMs).toBeLessThanOrEqual(21_500);
    expect(clock.reason).toMatch(/hard cap/);
  });

  it("keeps a normal utterance open under the cap", () => {
    const clock = segmentClock({
      startedMono: 1_000,
      nowMono: 4_000,
      startedWall: 10_000,
      nowWall: 13_000,
      maxUtteranceMs: 20_000,
    });
    expect(clock.close).toBe(false);
    expect(clock.bug).toBe(false);
  });
});

describe("microphone watch", () => {
  it("restarts a dead track, a muted track, missing frames, and a sleep jump", () => {
    expect(micWatch(base({ trackState: "ended" })).kind).toBe("track-ended");
    expect(micWatch(base({ muted: true })).kind).toBe("track-muted");
    expect(micWatch(base({ lastFrameMono: 0, nowMono: 5_000 })).kind).toBe("");
    expect(micWatch(base({ lastFrameMono: 1_000, nowMono: 4_000 })).kind).toBe("no-frames");
    expect(
      micWatch(base({ lastFrameMono: 1_000, nowMono: 1_100, lastWall: 1_000, nowWall: 9_000 }))
        .kind,
    ).toBe("sleep-resume");
    expect(micWatch(base({ speechForMs: 2_000, capturedSamples: 0 })).kind).toBe(
      "vad-without-audio",
    );
  });

  it("allows only a few restarts per minute", () => {
    expect(allowRestart([0, 10, 20], 30_000, 4)).toBe(true);
    expect(allowRestart([0, 10, 20, 30], 40_000, 4)).toBe(false);
  });
});

describe("pre-roll", () => {
  it("keeps audio from before the speech mark", () => {
    resetCaptureRing();
    const ring = new PcmRing(PRE_ROLL_MS);
    const before = new Float32Array(1600);
    before.fill(0.2);
    ring.push(before, 1_000, 16000);
    const during = new Float32Array(1600);
    during.fill(0.8);
    ring.push(during, 1_400, 16000);
    const heard = ring.takeSince(1_400 - PRE_ROLL_MS);
    expect(heard.length).toBeGreaterThan(1600);
    expect(heard[0]).toBeCloseTo(0.2);
    expect(heard[heard.length - 1]).toBeCloseTo(0.8);
    const wav = encodeWav(heard);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
  });
});

describe("transcription queue", () => {
  it("keeps order and drops the oldest short clip when the queue is full", () => {
    let queue: Array<{ item: string; samples: number }> = [];
    for (const [item, samples] of [
      ["a", 100],
      ["b", 9000],
      ["c", 9000],
    ] as const) {
      queue = admitUtterance(queue, item, samples, 3).queue;
    }
    const extra = admitUtterance(queue, "d", 9000, 3);
    expect(extra.dropped).toBe(1);
    expect(extra.queue.map((row) => row.item)).toEqual(["b", "c", "d"]);
  });
});

describe("captions and addressing", () => {
  it("collapses a repeated error", () => {
    const rows = collapseVoiceLog([
      { stage: "error", detail: "The microphone track ended. Reopening it." },
      { stage: "error", detail: "The microphone track ended. Reopening it." },
      { stage: "error", detail: "The microphone track ended. Reopening it." },
      { stage: "speech", detail: "speech detected" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.count).toBe(3);
  });

  it("answers a name, a follow-up, and not a weekday or someone else", () => {
    expect(decideAddressing({ text: "FRIDAY, kal ka schedule batao" }).tag).toBe("addressed");
    expect(decideAddressing({ text: "hey friday" }).reason).toBe("name");
    expect(decideAddressing({ text: "fraiday open chrome" }).answer).toBe(true);
    expect(decideAddressing({ text: "फ्राइडे लाइट बंद करो" }).answer).toBe(true);
    expect(decideAddressing({ text: "friday ji" }).answer).toBe(true);
    expect(decideAddressing({ text: "Friday ko meeting hai" }).reason).toBe("weekday");
    expect(decideAddressing({ text: "see you on Friday" }).answer).toBe(false);
    expect(
      decideAddressing({
        text: "kal ka schedule batao",
        followUpOpen: true,
      }).reason,
    ).toBe("follow-up");
    expect(
      decideAddressing({
        text: "kal ka schedule batao",
        mode: "name-only",
        followUpOpen: true,
      }).answer,
    ).toBe(false);
    expect(decideAddressing({ text: "hey alex pass the salt", followUpOpen: true }).tools).toBe(
      false,
    );
    expect(decideAddressing({ text: "rehne do", followUpOpen: true }).closeFollowUp).toBe(true);
    const meant = decideAddressing({ text: "what is the weather", mode: "meant-for-me" });
    expect(meant.answer).toBe(true);
    const vague = decideAddressing({ text: "hmm okay sure", mode: "meant-for-me" });
    expect(vague.answer).toBe(false);
    expect(vague.tools).toBe(false);
    const echo = decideAddressing({
      text: "your build finished successfully",
      lastSpoken: "your build finished successfully",
      recentlySpeaking: true,
    });
    expect(echo.tag).toBe("self");
    expect(echo.tools).toBe(false);
  });
});

describe("privacy and chat", () => {
  it("does not open a microphone in chat and does not send ambient text to the cloud", () => {
    expect(microphoneAllowed("manual", false)).toBe(false);
    expect(microphoneAllowed("auto", true)).toBe(false);
    expect(microphoneAllowed("auto", false)).toBe(true);
    resetHeardLog();
    noteHeard(
      {
        at: 1_000,
        text: "secret nearby sentence",
        tag: "ambient",
        language: "en",
        confidence: 0.4,
      },
      60_000,
      1_000,
    );
    expect(ambientContextForRoute({ privacy: true, allowAmbientCloud: true })).toBe("");
    expect(ambientContextForRoute({ privacy: false, allowAmbientCloud: false })).toBe("");
    expect(ambientContextForRoute({ privacy: false, allowAmbientCloud: true })).toContain(
      "secret nearby",
    );
    resetHeardLog();
  });

  it("expires rows, turns off, and clears without sending text off this PC", () => {
    resetHeardLog();
    const row = {
      at: 1_000,
      text: "keep this nearby",
      tag: "ambient" as const,
      language: "en",
      confidence: 0.4,
    };
    noteHeard(row, 1_000, 1_500, 40);
    noteHeard({ ...row, at: 1_000, text: "old line" }, 500, 2_000, 40);
    expect(heardRows().map((item) => item.text)).toEqual([]);
    noteHeard({ ...row, at: 4_000, text: "still here" }, 2_000, 5_000, 2);
    noteHeard({ ...row, at: 4_500, text: "second" }, 2_000, 5_000, 2);
    noteHeard({ ...row, at: 4_800, text: "third" }, 2_000, 5_000, 2);
    expect(heardRows()).toHaveLength(2);
    expect(heardRows().every((item) => 5_000 - item.at <= 2_000)).toBe(true);
    noteHeard({ ...row, at: 6_000, text: "off" }, 0, 6_000, 40);
    expect(heardRows()).toEqual([]);
    noteHeard({ ...row, at: 7_000, text: "rows off" }, 60_000, 7_000, 0);
    expect(heardRows()).toEqual([]);
    noteHeard({ ...row, at: 8_000, text: "cleared secret" }, 60_000, 8_000, 40);
    clearHeard();
    expect(heardRows()).toEqual([]);
    expect(ambientContextForRoute({ privacy: true, allowAmbientCloud: true })).toBe("");
    expect(ambientContextForRoute({ privacy: false, allowAmbientCloud: true })).toBe("");
    const source = readFileSync("src/lib/friday/heard-log.ts", "utf8");
    expect(source).not.toMatch(/fetch\(|https?:|websocket/i);
    resetHeardLog();
  });
});

describe("duration histogram", () => {
  it("buckets a clamped segment", () => {
    expect(durationBucket(400)).toBe("<=500");
    expect(durationBucket(21_000)).toBe("over");
  });
});

function base(patch: Partial<Parameters<typeof micWatch>[0]>): Parameters<typeof micWatch>[0] {
  return {
    live: true,
    lastFrameMono: 1_000,
    nowMono: 1_100,
    lastWall: 1_000,
    nowWall: 1_100,
    speechForMs: 0,
    capturedSamples: 8_000,
    segmentWallMs: 0,
    maxUtteranceMs: 20_000,
    trackState: "live",
    muted: false,
    ...patch,
  };
}
