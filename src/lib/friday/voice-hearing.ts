/**
 * Hearing diagnostics for one utterance and the Voice diagnostics tests.
 * The microphone and the speaker stay on the Auto session.
 */

import { encodeWav, TARGET_RATE } from "./pcm-capture";
import { resampleLinear, rms } from "./speech-dsp";

export const MIC_TEST_MS = 3000;
export const MIC_SILENT_RMS = 0.008;

let keepWavs = false;

export function setKeepUtteranceWavs(on: boolean): void {
  keepWavs = Boolean(on);
}

export function keepUtteranceWavs(): boolean {
  return keepWavs;
}

export type HearingAudio = {
  durationMs?: number;
  rmsDbfs?: number | null;
  peakDbfs?: number | null;
  denoisedRmsDbfs?: number | null;
  denoisedPeakDbfs?: number | null;
  vadMs?: number | null;
  noSpeechProb?: number | null;
  model?: string;
  device?: string;
  compute?: string;
  language?: string;
  promptUsed?: boolean;
  emptyReason?: string;
  denoiseNote?: string;
  passes?: string[];
};

export function captureClockNote(contextRate: number | null, target = TARGET_RATE): string {
  if (!contextRate) return "input clock stopped";
  if (contextRate === target) return `input ${contextRate} Hz`;
  return `input ${contextRate} Hz resampled to ${target} Hz`;
}

export function formatHearingDetail(audio: HearingAudio | null | undefined): string {
  if (!audio) return "";
  const db = (value: number | null | undefined) =>
    typeof value === "number" ? `${value.toFixed(0)} dBFS` : "n/a";
  const reason = audio.emptyReason ? ` · ${audio.emptyReason}` : "";
  const denoise = audio.denoiseNote ? ` · ${audio.denoiseNote}` : "";
  return (
    [
      `duration ${audio.durationMs ?? 0} ms`,
      `in ${db(audio.rmsDbfs)} peak ${db(audio.peakDbfs)}`,
      `out ${db(audio.denoisedRmsDbfs)} peak ${db(audio.denoisedPeakDbfs)}`,
      `vad ${audio.vadMs ?? 0} ms`,
      `no_speech ${typeof audio.noSpeechProb === "number" ? audio.noSpeechProb.toFixed(2) : "n/a"}`,
      `${audio.device || "cpu"}/${audio.compute || "int8"}`,
      audio.model || "model",
      audio.promptUsed ? "prompt on" : "prompt off",
    ].join(" · ") +
    denoise +
    reason
  );
}

export function transcriptDropDetail(result: {
  text?: string;
  emptyReason?: string;
  noSpeechProb?: number;
  audio?: HearingAudio | null;
}): string {
  const text = (result.text || "").trim();
  if (text) return text;
  const reason = result.emptyReason || result.audio?.emptyReason || "";
  if (reason) return reason;
  if (typeof result.noSpeechProb === "number" && result.noSpeechProb >= 0.7) {
    return `no_speech ${result.noSpeechProb.toFixed(2)}`;
  }
  return "empty transcript";
}

export function hearingVerdict(input: {
  rms: number;
  peak: number;
  transcript: string;
  emptyReason?: string;
  error?: string;
  deviceLabel?: string;
  contextRate?: number | null;
}): { stage: "mic-silent" | "stt" | "heard" | "capture"; line: string } {
  const device = input.deviceLabel || "default device";
  const clock = captureClockNote(input.contextRate ?? null);
  if (input.error) {
    return {
      stage: "capture",
      line: `Microphone did not record (${device}, ${clock}): ${input.error}`,
    };
  }
  if (input.rms < MIC_SILENT_RMS && input.peak < 0.02) {
    return {
      stage: "mic-silent",
      line: `Microphone is silent on ${device} (${clock}). The level meter did not move. This is the mic, not speech-to-text.`,
    };
  }
  const text = input.transcript.trim();
  if (!text) {
    const why = input.emptyReason || "empty transcript";
    return {
      stage: "stt",
      line: `Microphone has signal on ${device} (rms ${input.rms.toFixed(3)}, ${clock}). Speech-to-text returned nothing: ${why}.`,
    };
  }
  return { stage: "heard", line: `Heard on ${device}: ${text}` };
}

export async function recordFromStream(
  stream: MediaStream,
  ms = MIC_TEST_MS,
  onLevel?: (level: number) => void,
): Promise<{
  samples: Float32Array;
  rms: number;
  peak: number;
  contextRate: number;
  deviceLabel: string;
  wav: Uint8Array;
}> {
  const Ctx =
    typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!Ctx) throw new Error("audio capture is unavailable in this runtime");
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let peak = 0;
  let sum = 0;
  let count = 0;
  processor.onaudioprocess = (event) => {
    const data = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    for (let i = 0; i < data.length; i += 1) {
      const sample = data[i] ?? 0;
      sum += sample * sample;
      count += 1;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    if (count) onLevel?.(Math.sqrt(sum / count));
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);
  const rate = ctx.sampleRate || TARGET_RATE;
  try {
    await ctx.resume();
    await new Promise((resolve) => setTimeout(resolve, ms));
  } finally {
    processor.disconnect();
    source.disconnect();
    mute.disconnect();
    await ctx.close();
  }
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const samples = rate === TARGET_RATE ? joined : resampleLinear(joined, rate, TARGET_RATE);
  const track = stream.getAudioTracks()[0];
  return {
    samples,
    rms: rms(samples),
    peak,
    contextRate: rate,
    deviceLabel: track?.label || "default device",
    wav: encodeWav(samples, TARGET_RATE),
  };
}
