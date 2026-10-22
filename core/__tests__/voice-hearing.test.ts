import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  captureClockNote,
  DROP_CODES,
  dropLine,
  hearingCounters,
  hearingCountersLine,
  noteHearingOutcome,
  resetHearingCounters,
  formatHearingDetail,
  hearingVerdict,
  keepUtteranceWavs,
  setKeepUtteranceWavs,
  transcriptDropDetail,
} from "../../src/lib/friday/voice-hearing";

describe("voice hearing diagnostics", () => {
  it("names a silent microphone separately from an empty transcript", () => {
    const silent = hearingVerdict({
      rms: 0.001,
      peak: 0.004,
      transcript: "",
      deviceLabel: "Headset",
      contextRate: 48000,
    });
    expect(silent.stage).toBe("mic-silent");
    expect(silent.line).toContain("Microphone is silent");
    expect(silent.line).toContain("Headset");
    expect(silent.line).toContain("not speech-to-text");

    const stt = hearingVerdict({
      rms: 0.08,
      peak: 0.4,
      transcript: "",
      emptyReason: "vad kept 0 ms",
      deviceLabel: "Headset",
      contextRate: 48000,
    });
    expect(stt.stage).toBe("stt");
    expect(stt.line).toContain("vad kept 0 ms");
    expect(stt.line).toContain("has signal");

    const heard = hearingVerdict({
      rms: 0.08,
      peak: 0.4,
      transcript: "chrome open karo",
      deviceLabel: "Headset",
      contextRate: 16000,
    });
    expect(heard.stage).toBe("heard");
    expect(heard.line).toContain("chrome open karo");
  });

  it("logs the kernel reason instead of a bare empty transcript", () => {
    expect(
      transcriptDropDetail({
        text: "",
        emptyReason: "denoise-skipped: removed the signal",
        dropCode: "denoise-skipped",
      }),
    ).toBe("denoise-skipped: denoise-skipped: removed the signal");
    expect(transcriptDropDetail({ text: "hello" })).toBe("hello");
    expect(transcriptDropDetail({ text: "" })).toBe("empty: empty transcript");
    const line = formatHearingDetail({
      durationMs: 1400,
      rmsDbfs: -28,
      peakDbfs: -12,
      denoisedRmsDbfs: -29,
      denoisedPeakDbfs: -14,
      vadMs: 0,
      noSpeechProb: 0.83,
      device: "cpu",
      compute: "int8",
      model: "small",
      promptUsed: true,
      emptyReason: "vad kept 0 ms",
    });
    expect(line).toContain("vad 0 ms");
    expect(line).toContain("vad kept 0 ms");
    expect(line).toContain("prompt on");
    expect(captureClockNote(48000)).toContain("resampled to 16000");
    expect(captureClockNote(16000)).toBe("input 16000 Hz");
    expect(captureClockNote(null)).toBe("input clock stopped");
  });

  it("keeps utterance wavs off until the owner asks", () => {
    setKeepUtteranceWavs(false);
    expect(keepUtteranceWavs()).toBe(false);
    setKeepUtteranceWavs(true);
    expect(keepUtteranceWavs()).toBe(true);
    setKeepUtteranceWavs(false);
  });

  it("counts heard and dropped utterances by reason and never drops silently", () => {
    resetHearingCounters();
    noteHearingOutcome("");
    noteHearingOutcome("no-speech");
    noteHearingOutcome("no-speech");
    noteHearingOutcome("not-a-code");
    expect(dropLine("too-short", "tiny")).toBe("too-short: tiny");
    const counts = hearingCounters();
    expect(counts.heard).toBe(1);
    expect(counts.dropped["no-speech"]).toBe(2);
    expect(counts.dropped.empty).toBe(1);
    expect(counts.dropped["too-short"]).toBe(1);
    expect(counts.droppedTotal).toBe(4);
    expect(hearingCountersLine(counts)).toContain("no-speech 2");
    resetHearingCounters();
    expect(hearingCounters().droppedTotal).toBe(0);
  });

  it("keeps the drop codes equal to the kernel list and the number in one place", () => {
    const kernel = readFileSync("kernel/voice_runtime.py", "utf8");
    const block = /DROP_CODES = \(([\s\S]*?)\)/.exec(kernel)?.[1] ?? "";
    const codes = [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(codes).toEqual([...DROP_CODES]);
    for (const file of ["voice-stt.ts", "voice-hearing.ts"]) {
      const body = readFileSync(`src/lib/friday/${file}`, "utf8");
      expect(body).not.toMatch(/>=\s*0\.(65|7)\b/);
    }
  });
});
