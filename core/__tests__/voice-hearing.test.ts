import { describe, expect, it } from "vitest";
import {
  captureClockNote,
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
        emptyReason: "denoise removed the signal",
        noSpeechProb: 0.91,
      }),
    ).toBe("denoise removed the signal");
    expect(transcriptDropDetail({ text: "hello", noSpeechProb: 0.8 })).toBe("hello");
    expect(transcriptDropDetail({ text: "" })).toBe("empty transcript");
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
});
